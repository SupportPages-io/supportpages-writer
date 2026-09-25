import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { localFixture, article, context, remote } from './helpers.mjs';
import { Session, credentialLocation } from '../dist/session.js';
import { saveTokenFile } from '../dist/credentials.js';
import { createServer } from '../dist/server.js';

const origin = 'https://app.supportpages.io';
const token = 'sp_local_' + 'b'.repeat(64), secret = 'c'.repeat(64), pairingId = 'a'.repeat(64);
const account = { id: '10', email: 'alice@example.com' };
async function setup(t, { titles = ['Alpha', 'Beta'], signedIn = true, approval, holdAcknowledgment = false } = {}) {
  const f = await localFixture(t);
  for (const title of titles) {
    const prepared = await f.bridge.prepare({ title, article_type: 'how-to' });
    await f.output({ ...article, title });
    await f.bridge.complete({ run_id: prepared.run_id, completed: true });
  }
  const calls = [], imported = [];
  let approved = false, wake, failTitle;
  let acknowledge;
  const acknowledgment = new Promise(resolve => { acknowledge = resolve; });
  const runtime = { now: Date.now, sleep: async () => {
    if (!approved) await new Promise(resolve => { wake = resolve; });
  }, fetcher: async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/pairings')) {
      assert.deepEqual(JSON.parse(init.body).requested_scopes, ['read', 'import', 'projects:create', 'publish', 'manage', 'generate']);
      return Response.json({ pairing_id: pairingId, pairing_secret: secret,
        verification_uri: `${origin}/settings/mcp/connect/${pairingId}`, user_code: 'ABCD-EFGH',
        expires_at: new Date(Date.now() + 600_000).toISOString(), interval: 3 });
    }
    if (url.endsWith('/poll')) return Response.json({ status: 'approved' });
    if (url.endsWith('/exchange')) return Response.json({ status: 'authorized', api_origin: origin, account, token,
      scopes: ['read', 'import', 'projects:create'], token_expires_at: new Date(Date.now() + 86400_000).toISOString() });
    if (holdAcknowledgment && url.endsWith('/acknowledge')) await acknowledgment;
    return Response.json({ status: 'completed' });
  } };
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, init });
    assert.equal(init.headers.Authorization, `Bearer ${token}`);
    if (url.endsWith('/projects')) return Response.json({ projects: [context.project, { id: '2', name: 'Other' }] });
    if (url.endsWith('/context')) return Response.json({ ...context, project: { ...context.project, id: url.includes('/projects/2/') ? '2' : '1' } });
    if (url.endsWith('/article_imports')) {
      const value = JSON.parse(await init.body.get('article').text());
      if (value.title === failTitle) return Response.json({ error: { code: 'plan_limit' } }, { status: 403 });
      imported.push(value.title);
      return Response.json({ import_id: String(imported.length), article: { ...remote, id: String(imported.length), editor_url: `${remote.editor_url}-${imported.length}` } });
    }
    assert.fail(`Unexpected request ${url}`);
  });
  const session = new Session({ cwd: f.root, origin, dev: false, skillsDir: f.bridge.skillsDir,
    configDir: path.join(f.root, 'config'), pairingRuntime: runtime });
  if (signedIn) await saveTokenFile(credentialLocation(origin, session.options.configDir).filename, origin, token, account);
  const server = createServer(session);
  const client = new Client({ name: 'publish-test', version: '1' }, { capabilities: approval ? { elicitation: { url: {} } } : {} });
  if (approval) client.setRequestHandler(ElicitRequestSchema, async request => {
    assert.match(request.params.message, /ABCD-EFGH/);
    approved = approval === 'accept';
    return { action: approval };
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  t.after(async () => { session.close(); await client.close(); });
  const call = async (args = {}) => {
    const result = await client.callTool({ name: 'supportpages_publish', arguments: args });
    assert.ok(!JSON.stringify(result).includes(token)); assert.ok(!JSON.stringify(result).includes(secret));
    return result.structuredContent;
  };
  return { ...f, session, client, calls, imported, call, acknowledge, fail: title => { failTitle = title; }, approve: () => { approved = true; wake?.(); } };
}

test('MCP publish selects a help centre and articles, shares the CLI uploader, and leaves drafts', async t => {
  const f = await setup(t);
  const definition = (await f.client.listTools()).tools.find(tool => tool.name === 'supportpages_publish');
  assert.equal(definition.annotations.openWorldHint, true);
  assert.equal(definition.inputSchema.properties.token, undefined);
  const choice = (await f.call()).result;
  assert.equal(choice.status, 'project_required');
  assert.deepEqual(choice.articles.map(item => item.slug), ['alpha', 'beta']);
  assert.equal(await f.ws.exists('.rtfm/supportpages/binding.json'), false);
  const selection = (await f.call({ project_id: '1' })).result;
  assert.equal(selection.status, 'selection_required');
  assert.equal(f.imported.length, 0);
  const uploaded = (await f.call({ project_id: '1', slugs: ['beta'] })).result;
  assert.equal(uploaded.status, 'drafts_uploaded');
  assert.deepEqual(uploaded.uploaded.map(item => item.slug), ['beta']);
  assert.deepEqual(f.imported, ['Beta']);
  assert.equal((await f.ws.json('.rtfm/supportpages/articles/beta.json')).remote.status, 'draft');
  assert.equal(await f.ws.exists('output/articles/beta/index.md'), true);
  assert.deepEqual((await f.call()).result.articles.map(item => item.slug), ['alpha']);
  const repeated = (await f.call({ slugs: ['beta'] })).result;
  assert.equal(repeated.already_uploaded[0].slug, 'beta');
  assert.deepEqual(f.imported, ['Beta']);
  assert.ok(!f.calls.some(call => call.url.endsWith('/publish')));
  assert.equal((await f.call({ project_id: '2', slugs: ['alpha'] })).error.code, 'destination_mismatch');
});

test('MCP publish returns browser approval and resumes with the same saved articles after private sign-in', async t => {
  const f = await setup(t, { signedIn: false, holdAcknowledgment: true });
  const pending = (await f.call()).result;
  assert.equal(pending.status, 'authentication_required');
  assert.equal(pending.user_code, 'ABCD-EFGH');
  assert.equal(pending.verification_uri, `${origin}/settings/mcp/connect/${pairingId}`);
  assert.equal(f.imported.length, 0);
  f.approve();
  for (let i = 0; i < 100 && !(await f.session.account()); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(await f.session.account(), account);
  assert.equal((await f.session.status()).status, 'approval_pending');
  assert.equal(f.imported.length, 0);
  f.acknowledge();
  // The credential is saved before the server acknowledges delivery. Observe
  // public completion, as an MCP client does, rather than racing that final step.
  for (let i = 0; i < 100 && (await f.session.status()).status === 'approval_pending'; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await f.session.status()).status, 'local');
  const uploaded = (await f.call({ project_id: '1', slugs: ['alpha'] })).result;
  assert.equal(uploaded.status, 'drafts_uploaded');
  assert.deepEqual(f.imported, ['Alpha']);
});

test('URL elicitation approval continues the selected publish flow instead of returning to local init', async t => {
  const f = await setup(t, { signedIn: false, approval: 'accept' });
  const result = (await f.call({ project_id: '1', slugs: ['alpha'] })).result;
  assert.equal(result.status, 'drafts_uploaded');
  assert.deepEqual(f.imported, ['Alpha']);
});

test('declined approval and empty local inventory never upload or bind the workspace', async t => {
  const f = await setup(t, { signedIn: false, approval: 'decline' });
  assert.equal((await f.call({ project_id: '1', slugs: ['alpha'] })).result.status, 'authorization_cancelled');
  assert.equal(await f.ws.exists('.rtfm/supportpages/binding.json'), false);
  assert.equal(f.imported.length, 0);
  const empty = await setup(t, { signedIn: false, titles: [] });
  assert.equal((await empty.call()).error.code, 'nothing_to_publish');
  assert.equal(empty.calls.length, 0);
});

test('publish preserves partial success and retries only remaining articles after a capacity failure', async t => {
  const f = await setup(t, { titles: ['Alpha', 'Beta', 'Gamma'] });
  f.fail('Beta');
  const first = (await f.call({ project_id: '1', slugs: ['alpha', 'beta', 'gamma'] })).result;
  assert.equal(first.status, 'upload_incomplete');
  assert.equal(first.failed[0].error.code, 'plan_limit');
  assert.deepEqual(first.skipped, ['gamma']);
  assert.deepEqual(f.imported, ['Alpha']);
  f.fail(undefined);
  const second = (await f.call({ slugs: ['alpha', 'beta', 'gamma'] })).result;
  assert.equal(second.status, 'drafts_uploaded');
  assert.equal(second.already_uploaded[0].slug, 'alpha');
  assert.deepEqual(f.imported, ['Alpha', 'Beta', 'Gamma']);
  assert.equal((await f.call()).result.status, 'up_to_date');
});

test('publish rejects unknown selections before upload and refuses to interrupt active local writing', async t => {
  const f = await setup(t);
  assert.equal((await f.call({ project_id: '1', slugs: ['alpha', 'unknown'] })).error.code, 'invalid_article');
  assert.equal(f.imported.length, 0);
  assert.equal((await f.call({ slugs: [] })).result.uploaded.length, 0);
  const active = await setup(t, { signedIn: false });
  await active.bridge.prepare({ title: 'In progress', article_type: 'how-to' });
  assert.equal((await active.call()).error.code, 'generation_active');
  assert.equal(active.calls.length, 0);
  assert.equal(await active.ws.exists('.rtfm/supportpages/binding.json'), false);
});
