import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { localFixture, context } from './helpers.mjs';
import { Session, credentialLocation } from '../dist/session.js';
import { Bridge } from '../dist/bridge.js';
import { writerAction } from '../dist/actions.js';
import { saveTokenFile, readTokenFile } from '../dist/credentials.js';
import { mcp, result } from './scenario-helpers.mjs';

const origin = 'https://app.supportpages.io', token = 'sp_local_' + 'b'.repeat(64), replacement = 'sp_local_' + 'd'.repeat(64);
const pairingId = 'a'.repeat(64), secret = 'c'.repeat(64), approvalUrl = `${origin}/settings/mcp/connect/${pairingId}`;
const repoUrl = `${origin}/projects/example/repository_connection?source=completion`;
const account = { id: '10', email: 'test@example.com' };
const action = 'create_video_walkthrough';

async function setup(t, { signedIn = false, bound = false, browser = true, scopes = ['read', 'import', 'projects:create', 'generate'] } = {}) {
  const f = await localFixture(t);
  const calls = [], opened = [];
  let approved = false, wake, denied = false, status = 'repository_required', targetUrl = repoUrl;
  const runtime = { now: Date.now, sleep: async () => { if (!approved && !denied) await new Promise(resolve => { wake = resolve; }); else await sleep(1); }, fetcher: async (url, init) => {
    calls.push({ url, method: init.method, body: init.body && JSON.parse(init.body) });
    if (url.endsWith('/pairings')) return Response.json({ pairing_id: pairingId, pairing_secret: secret, verification_uri: approvalUrl, user_code: 'ABCD-EFGH', expires_at: new Date(Date.now() + 600_000).toISOString(), interval: 3 });
    if (url.endsWith('/poll')) return Response.json({ status: denied ? 'denied' : 'approved' });
    if (url.endsWith('/exchange')) return Response.json({ status: 'authorized', api_origin: origin, account, token: replacement, scopes: ['read', 'import', 'projects:create', 'generate'], token_expires_at: new Date(Date.now() + 86400_000).toISOString() });
    if (url.endsWith('/acknowledge')) { scopes = ['read', 'import', 'projects:create', 'generate']; return Response.json({ status: 'completed' }); }
    assert.fail(`Unexpected pairing request ${url}`);
  } };
  const session = new Session({ cwd: f.root, origin, dev: false, skillsDir: f.bridge.skillsDir, configDir: path.join(f.root, 'setup-config'), pairingRuntime: runtime });
  t.after(() => session.close());
  session.openBrowser = async url => { opened.push(url); return browser; };
  const credential = credentialLocation(origin, session.options.configDir).filename;
  if (signedIn) await saveTokenFile(credential, origin, token, account);
  if (bound) await f.ws.writeJson(`${f.bridge.stateRoot}/binding.json`, { version: 1, api_origin: origin, project_id: '1' });
  const decision = name => ({ action: name, execution: 'hosted', allowed: status === 'ready', required_scopes: ['read', 'generate'], next_step: status === 'ready' ? null : { code: status, message: `Complete ${status}.`, requested_action: name, ...(status === 'permission_required' ? { missing_scopes: ['generate'] } : { url: targetUrl }) } });
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, method: init.method });
    assert.equal(init.method, 'GET', 'setup must not upload, generate or approve repository access');
    if (url.endsWith('/projects')) return Response.json({ projects: [{ id: '1', name: 'Example' }] });
    if (url.endsWith('/mcp/settings')) return Response.json({ account, scopes });
    if (url.endsWith('/context')) return Response.json({ ...context, repository_connection: { ...context.repository_connection, writer: { version: 1, actions: Object.fromEntries(writerAction.options.map(name => [name, decision(name)])) } } });
    if (url.includes('/writer/capabilities')) return Response.json({ version: 1, decision: decision(new URL(url).searchParams.get('action_name')) });
    assert.fail(`Unexpected API request ${url}`);
  });
  t.mock.method(Bridge.prototype, 'resumeWriterCompletion', async () => assert.fail('setup must not resume a local writer'));
  const call = await mcp(t, session);
  return { ...f, session, call, calls, opened, credential, setStatus: value => { status = value; }, setUrl: value => { targetUrl = value; },
    approve: async () => {
      approved = true; wake?.();
      for (let i = 0; i < 100 && !calls.some(c => c.url.endsWith('/acknowledge')); i++) await sleep(5);
      assert.ok(calls.some(c => c.url.endsWith('/acknowledge')));
      await sleep(5);
    }, deny: async () => { denied = true; wake?.(); await sleep(10); } };
}

test('one MCP setup flow opens account approval before selecting a help centre and opening its repository page', async t => {
  const f = await setup(t);
  const local = await f.ws.read(`${f.bridge.stateRoot}/local.json`);
  await f.ws.write('output/articles/contact/index.md', '# Add a contact\n');
  const resume = { request_id: '11111111-1111-4111-8111-111111111111', prefer_background: true };
  const first = result(await f.call('setup_hosted', { action, resume_arguments: resume }));
  assert.equal(first.status, 'authentication_required');
  assert.equal(first.next_tool, 'supportpages_setup_hosted');
  assert.equal(first.browser_opened, true);
  assert.equal(first.user_code, 'ABCD-EFGH');
  assert.deepEqual(f.opened, [approvalUrl]);
  assert.ok(!f.calls.some(c => c.url.endsWith('/projects')));
  assert.deepEqual(f.calls[0].body.requested_scopes, ['read', 'import', 'projects:create', 'publish', 'manage', 'generate']);
  const again = result(await f.call('setup_hosted', first.next_arguments));
  assert.equal(again.verification_uri, first.verification_uri);
  assert.equal(f.opened.length, 1);
  assert.equal(f.calls.filter(c => c.url.endsWith('/pairings')).length, 1);
  assert.equal(await f.ws.exists(`${f.bridge.stateRoot}/binding.json`), false);
  await f.approve();
  const choose = result(await f.call('setup_hosted', first.next_arguments));
  assert.equal(choose.status, 'project_required');
  assert.equal(await f.ws.exists(`${f.bridge.stateRoot}/binding.json`), false);
  const repository = result(await f.call('setup_hosted', { ...choose.next_arguments, project_id: '1' }));
  assert.equal(repository.next_step.code, 'repository_required');
  assert.deepEqual(f.opened, [approvalUrl, repoUrl]);
  assert.deepEqual(await f.ws.read(`${f.bridge.stateRoot}/local.json`), local);
  f.setStatus('ready');
  const ready = result(await f.call('setup_hosted', repository.next_arguments));
  assert.equal(ready.status, 'available');
  assert.equal(ready.resume_tool, 'supportpages_create_video_walkthrough');
  assert.equal(ready.resume_arguments.request_id, resume.request_id);
  assert.equal(ready.resume_arguments.prefer_background, true);
  assert.equal(await f.ws.exists(`${f.bridge.stateRoot}/active-run.json`), false);
  assert.equal(await f.ws.exists(`${f.bridge.stateRoot}/operations`), false);
  assert.match(await readFile(path.join(f.root, 'output/articles/contact/index.md'), 'utf8'), /Add a contact/);
  assert.ok(!JSON.stringify([first, choose, repository, ready]).includes(secret));
  assert.ok(!JSON.stringify([first, choose, repository, ready]).includes(replacement));
});

for (const tool of ['create_video_walkthrough', 'find_article_gaps', 'suggest_sections', 'recommend_articles']) {
  test(`signed-out ${tool} starts the browser setup step, not generation`, async t => {
    const f = await setup(t);
    const value = result(await f.call(tool));
    assert.equal(value.requested_action, tool);
    assert.equal(value.next_arguments.action, tool);
    assert.equal(value.resume_tool, `supportpages_${tool}`);
    assert.deepEqual(f.opened, [approvalUrl]);
    assert.equal(f.calls.filter(c => !c.url.endsWith('/pairings')).length, 0);
  });
}

test('browser launch failure returns the actual approval link without falling back to the homepage', async t => {
  const f = await setup(t, { browser: false });
  const value = result(await f.call('setup_hosted', { action }));
  assert.equal(value.browser_opened, false);
  assert.equal(value.browser_url, approvalUrl);
});

test('connected account opens only repository recovery and repeated setup does not reopen tabs', async t => {
  const f = await setup(t, { signedIn: true, bound: true });
  f.setStatus('repository_suspended');
  const first = result(await f.call('setup_hosted', { action, article_id: '5' }));
  assert.equal(first.next_step.code, 'repository_suspended');
  await f.call('setup_hosted', first.next_arguments);
  assert.deepEqual(f.opened, [repoUrl]);
  assert.equal(first.resume_arguments.article_id, '5');
  assert.equal(f.calls.some(c => c.method === 'POST'), false);
});

test('missing device permissions open consent before repository setup and preserve the existing token', async t => {
  const f = await setup(t, { signedIn: true, bound: true, scopes: ['read', 'import', 'projects:create'] });
  f.setStatus('permission_required');
  const first = result(await f.call('setup_hosted', { action }));
  assert.equal(first.browser_url, approvalUrl);
  assert.deepEqual(f.opened, [approvalUrl]);
  assert.equal(await readTokenFile(f.credential, origin), token);
  await f.approve();
  assert.equal(await readTokenFile(f.credential, origin), replacement);
  f.setStatus('repository_required');
  await f.call('setup_hosted', first.next_arguments);
  assert.deepEqual(f.opened, [approvalUrl, repoUrl]);
});

test('a denied browser grant does not open repository setup, write a token or submit a job', async t => {
  const f = await setup(t);
  const first = result(await f.call('setup_hosted', { action }));
  await f.deny();
  const denied = await f.call('setup_hosted', first.next_arguments);
  assert.equal(denied.structuredContent.error.code, 'authorization_denied');
  await assert.rejects(readFile(f.credential), { code: 'ENOENT' });
  assert.deepEqual(f.opened, [approvalUrl]);
  assert.equal(f.calls.some(c => c.url.includes('/writer_operations')), false);
});

test('setup rejects foreign recovery URLs and cannot replace an existing help-centre binding', async t => {
  const f = await setup(t, { signedIn: true, bound: true });
  f.setUrl('https://unrelated.example/connect');
  assert.equal((await f.call('setup_hosted', { action })).structuredContent.error.code, 'invalid_response');
  assert.deepEqual(f.opened, []);
  // The context identity also protects a request for a different project.
  assert.equal((await f.call('setup_hosted', { action, project_id: '2' })).structuredContent.error.code, 'invalid_response');
  assert.equal((await f.ws.json(`${f.bridge.stateRoot}/binding.json`)).project_id, '1');
});

test('the compatibility tool follows account-first setup and reports the original feature action', async t => {
  const f = await setup(t);
  const value = result(await f.call('connect_repository', { feature: 'video_walkthrough' }));
  assert.equal(value.requested_action, action);
  assert.deepEqual(f.opened, [approvalUrl]);
});

test('concurrent setup requests reuse one sign-in while preserving each requested action', async t => {
  const f = await setup(t);
  const [video, gaps] = await Promise.all([
    f.session.setupHosted({ action }), f.session.setupHosted({ action: 'find_article_gaps' }),
  ]);
  assert.equal(video.requested_action, action);
  assert.equal(gaps.requested_action, 'find_article_gaps');
  assert.equal(f.calls.filter(c => c.url.endsWith('/pairings')).length, 1);
  assert.deepEqual(f.opened, [approvalUrl]);
});

test('declining client consent does not fall back to opening the browser', async t => {
  const f = await setup(t);
  f.session.approval = async () => 'decline';
  const value = result(await f.call('setup_hosted', { action }));
  assert.equal(value.status, 'authorization_cancelled');
  assert.match(value.instructions, /only if the user requests/);
  assert.deepEqual(f.opened, []);
  await assert.rejects(readFile(f.credential), { code: 'ENOENT' });
});

test('revoked device credentials restart browser approval before any repository page', async t => {
  const f = await setup(t, { signedIn: true, bound: true });
  t.mock.method(globalThis, 'fetch', async () => Response.json({}, { status: 401 }));
  const value = result(await f.call('setup_hosted', { action }));
  assert.equal(value.status, 'authentication_required');
  assert.deepEqual(f.opened, [approvalUrl]);
  assert.equal(await readTokenFile(f.credential, origin), token, 'old credential stays until new consent succeeds');
});

test('setup resumes from returned arguments after an MCP restart without starting work', async t => {
  const f = await setup(t, { signedIn: true, bound: true });
  const first = result(await f.call('setup_hosted', { action, article_id: '5', resume_arguments: { prefer_background: false } }));
  f.session.close();
  const resumed = new Session(f.session.options);
  resumed.openBrowser = async () => assert.fail('ready setup needs no browser');
  f.setStatus('ready');
  const call = await mcp(t, resumed);
  const ready = result(await call('setup_hosted', first.next_arguments));
  assert.equal(ready.status, 'available');
  assert.equal(ready.resume_arguments.article_id, '5');
  assert.equal(ready.resume_arguments.prefer_background, false);
  assert.equal(f.calls.some(c => c.method !== 'GET'), false);
});
