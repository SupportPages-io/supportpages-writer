import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { fixture } from './helpers.mjs';
import { Session, credentialLocation } from '../dist/session.js';
import { saveTokenFile } from '../dist/credentials.js';
const origin = 'https://app.supportpages.io';
const token = 'sp_local_' + 'b'.repeat(64), secret = 'c'.repeat(64), id = 'a'.repeat(64);
async function setup(t, runtime) {
  const f = await fixture(t);
  const session = new Session({ cwd: f.root, origin, dev: false, configDir: path.join(f.root, 'config'), skillsDir: '', pairingRuntime: runtime });
  t.after(() => session.close());
  return { ...f, session, credential: credentialLocation(origin, session.options.configDir).filename };
}
function network(t, handler) {
  const previous = globalThis.fetch; globalThis.fetch = handler; t.after(() => { globalThis.fetch = previous; });
}
test('unconfigured status neither calls the service nor creates configuration', async t => {
  const f = await setup(t);
  network(t, async () => assert.fail('status must not start authentication'));
  const result = await f.session.status();
  // A folder nobody has set up needs a destination, not a credential: saving
  // articles in the project costs no account, so this must never read as a
  // sign-in failure or tell the agent that hosting is required.
  assert.equal(result.status, 'setup_required'); assert.equal(result.credentials_configured, false);
  assert.match(result.instructions, /no account is needed/i);
  assert.doesNotMatch(result.instructions, /not signed in/i);
  assert.equal(result.workspace, f.root);
  await assert.rejects(stat(f.session.options.configDir), { code: 'ENOENT' });
  assert.equal(await f.ws.exists('.rtfm/supportpages/connection.json'), false);
});
test('status reports ready and project access using only GET, without writing connection state', async t => {
  const f = await setup(t); await saveTokenFile(f.credential, origin, token);
  await f.ws.writeJson('.rtfm/supportpages/binding.json', { version: 1, api_origin: origin, project_id: '1' });
  const before = await readFile(f.credential, 'utf8'); let calls = 0;
  network(t, async (url, options) => {
    calls++; assert.equal(url, `${origin}/api/v1/projects`); assert.equal(options.method, 'GET');
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    return Response.json({ projects: [{ id: '1', name: 'Example' }] });
  });
  const result = await f.session.status();
  assert.equal(result.status, 'ready'); assert.deepEqual(result.project, { id: '1', name: 'Example' });
  assert.equal(result.credentials_configured, true); assert.equal(calls, 1);
  assert.ok(!JSON.stringify(result).includes(token));
  assert.equal(await readFile(f.credential, 'utf8'), before);
  assert.equal(await f.ws.exists('.rtfm/supportpages/connection.json'), false);
});
test('status distinguishes missing binding, lost access, rejected credentials and network failure', async t => {
  const f = await setup(t); await saveTokenFile(f.credential, origin, token);
  let response = () => Response.json({ projects: [] });
  network(t, async () => response());
  assert.equal((await f.session.status()).status, 'project_required');
  await f.ws.writeJson('.rtfm/supportpages/binding.json', { version: 1, api_origin: origin, project_id: '1' });
  assert.equal((await f.session.status()).status, 'project_unavailable');
  response = () => new Response(token, { status: 401 });
  const rejected = await f.session.status();
  assert.equal(rejected.status, 'authentication_required'); assert.equal(rejected.error.code, 'invalid_credentials');
  assert.ok(!JSON.stringify(rejected).includes(token));
  response = () => { throw new Error(token); };
  const offline = await f.session.status();
  assert.equal(offline.status, 'connection_error'); assert.equal(offline.error.code, 'network_error');
  assert.ok(!JSON.stringify(offline).includes(token));
});
test('status returns a safe error for an invalid credential file without starting pairing', async t => {
  const f = await setup(t); await saveTokenFile(f.credential, 'https://other.example', token);
  network(t, async () => assert.fail('must not call the service'));
  const result = await f.session.status();
  assert.equal(result.status, 'authentication_required'); assert.equal(result.error.code, 'invalid_credentials_file');
  assert.ok(!JSON.stringify(result).includes(token));
});
test('status observes pending and denied approval without polling again or consuming the failure', async t => {
  let wake, calls = 0;
  const runtime = { now: Date.now, sleep: () => new Promise(resolve => { wake = resolve; }), fetcher: async url => {
    calls++;
    if (url.endsWith('/pairings')) return Response.json({ pairing_id: id, pairing_secret: secret,
      verification_uri: `${origin}/settings/mcp/connect/${id}`, user_code: 'ABCD-EFGH',
      expires_at: new Date(Date.now() + 600_000).toISOString(), interval: 3 });
    return Response.json({ status: 'denied' });
  } };
  const f = await setup(t, runtime);
  network(t, async () => assert.fail('status must not make a separate request during pairing'));
  await f.session.init({});
  for (let i = 0; i < 2; i++) {
    const pending = await f.session.status();
    assert.equal(pending.status, 'approval_pending'); assert.equal(pending.user_code, 'ABCD-EFGH');
    assert.ok(!JSON.stringify(pending).includes(secret));
  }
  assert.equal(calls, 1);
  wake(); await new Promise(resolve => setImmediate(resolve));
  for (let i = 0; i < 2; i++) {
    const denied = await f.session.status();
    assert.equal(denied.status, 'authorization_failed'); assert.equal(denied.error.code, 'authorization_denied');
  }
  assert.equal(calls, 2);
  await assert.rejects(f.session.init({}), { code: 'authorization_denied' });
});

test('connection failures do not hide a saved draft review link', async t => {
  const f = await setup(t); await saveTokenFile(f.credential, origin, token);
  const runId = '00000000-0000-4000-8000-000000000002';
  const run = { id: runId, local_article_id: '00000000-0000-4000-8000-000000000001', artifact_dir: 'output/articles/invite',
    started_at: new Date().toISOString(), section_id: null, status: 'finalized', skills_version: '1', phase: 'ready_for_review',
    remote: { id: '1', revision: 'a'.repeat(64), status: 'draft', editor_url: `${origin}/projects/example/articles_page?article=1`, public_url: null } };
  await f.ws.writeJson(`.rtfm/supportpages/runs/${runId}/run.json`, run);
  await f.ws.writeJson('.rtfm/supportpages/active-run.json', run);
  network(t, async () => { throw new Error('offline'); });
  const result = await f.session.status();
  assert.equal(result.status, 'connection_error'); assert.equal(result.article_run.editor_url, run.remote.editor_url);
  assert.equal(result.article_run.phase, 'ready_for_review');
});
test('a folder that saves articles locally reports local without any network, with or without a credential', async t => {
  const f = await setup(t, { fetcher: async () => assert.fail('local folders never start pairing'), now: Date.now, sleep: () => new Promise(() => {}) });
  network(t, async () => assert.fail('local status must not call the service'));
  await (await f.session.bridge()).saveLocal({ version: 1, export_dir: 'docs/help', writing_style: 'formal' });
  let result = await f.session.status();
  assert.equal(result.status, 'local'); assert.equal(result.export_dir, 'docs/help'); assert.equal(result.generation_ready, false);
  assert.equal((await f.session.init({})).status, 'local');
  await saveTokenFile(f.credential, origin, token);
  result = await f.session.status();
  assert.equal(result.status, 'local'); assert.equal(result.credentials_configured, true);
  const initialized = await f.session.init({});
  assert.equal(initialized.status, 'local'); assert.match(initialized.instructions, /supportpages analyse/);
});
