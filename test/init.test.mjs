import test from 'node:test';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Session, credentialLocation } from '../dist/session.js';
import { readCredential } from '../dist/credentials.js';
import { authenticate } from '../scripts/auth.mjs';
import { fixture } from './helpers.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
const token = 'sp_local_' + 'b'.repeat(64);
const origin = 'https://app.lvh.me:3443';
const account = { id: '10', email: 'alice@example.com' };
const startResponse = (apiOrigin = origin) => ({ pairing_id: 'a'.repeat(64), pairing_secret: 'c'.repeat(64),
  verification_uri: `${apiOrigin}/settings/mcp/connect/${'a'.repeat(64)}`, user_code: 'ABCD-EFGH',
  expires_at: new Date(Date.now() + 600_000).toISOString(), interval: 3 });

async function sessionFixture(t) {
  const f = await fixture(t);
  const configDir = path.join(f.root, 'private-user-config');
  const session = new Session({ cwd: f.root, origin, dev: true, skillsDir: path.join(f.root, 'skills'), configDir,
    pairingRuntime: { fetcher: async () => Response.json(startResponse()), now: Date.now, sleep: () => new Promise(() => {}) } });
  t.after(() => session.close());
  return { ...f, session, configDir };
}
const settingsFetcher = async (_url, init) => { assert.equal(init.headers.Authorization, `Bearer ${token}`); return Response.json({ account }); };

test('init opens sign-in privately; a manual token signs the device in and a chosen help centre then binds', async t => {
  const f = await sessionFixture(t);
  const first = await f.session.init({});
  assert.equal(first.status, 'authentication_required');
  assert.equal(first.verification_uri, startResponse().verification_uri);
  assert.equal(first.command, undefined);
  f.session.close();
  f.session = new Session(f.session.options);
  const logs = [];
  await authenticate({ 'api-url': origin, dev: true, 'config-dir': f.configDir }, { ui: { line: s => logs.push(s), secret: async () => token }, fetcher: settingsFetcher });
  assert.equal((await f.session.bridge()).api.configured(), true);
  const credential = credentialLocation(origin, f.configDir);
  assert.equal((await stat(credential.filename)).mode & 0o777, 0o600);
  assert.deepEqual(await readCredential(credential.filename, origin), { token, account });
  assert.ok(!JSON.stringify(logs).includes(token));
  assert.match(logs.join('\n'), /alice@example.com/);
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async url => url.endsWith('/context') ? Response.json({ project: { id: '1', name: 'Example' }, supported_bundle_versions: [1], sections: [], articles: [] }) : Response.json({ projects: [{ id: '1', name: 'Example' }] });
  try {
    const unbound = await f.session.init({});
    assert.equal(unbound.status, 'project_required');
    assert.deepEqual(unbound.projects, { projects: [{ id: '1', name: 'Example' }] });
    assert.equal(unbound.account.email, account.email);
    const ready = await f.session.init({ project_id: '1' });
    assert.equal(ready.status, 'ready');
    assert.equal(ready.account.email, account.email);
    const bridge = await f.session.bridge();
    assert.equal(await bridge.ws.exists(`${bridge.stateRoot}/connection.json`), false);
  } finally { globalThis.fetch = savedFetch; }
});

test('failed authentication saves nothing, and credentials are origin scoped but shared across folders', async t => {
  const f = await sessionFixture(t);
  await assert.rejects(authenticate({ 'api-url': origin, dev: true, 'config-dir': f.configDir }, {
    ui: { line: () => {}, secret: async () => token }, fetcher: async () => new Response(token, { status: 401 })
  }), e => e.code === 'invalid_credentials' && !e.message.includes(token));
  await assert.rejects(stat(f.configDir), { code: 'ENOENT' });
  assert.notEqual(credentialLocation(origin, f.configDir).filename, credentialLocation('https://app.supportpages.io', f.configDir).filename);
  const other = new Session({ ...f.session.options, cwd: path.join(f.root, 'other') });
  assert.equal(credentialLocation(origin, f.configDir).filename, credentialLocation(other.options.origin, other.options.configDir).filename);
});

test('workspace discovery prefers explicit and Claude project context, handles ambiguous and changed roots', async t => {
  const f = await sessionFixture(t);
  const other = path.join(f.root, 'other'); await mkdir(other);
  f.session.roots = async () => [f.root, other];
  await assert.rejects(f.session.workspace(), { code: 'workspace_required' });
  assert.equal((await f.session.workspace(other)).root, other);
  f.session.roots = async () => [f.root];
  await assert.rejects(f.session.workspace(), { code: 'invalid_workspace' });
  assert.equal((await f.session.workspace(f.root)).root, f.root);
  const claude = new Session({ ...f.session.options, projectDir: other });
  claude.roots = async () => { throw new Error('Claude project is already known'); };
  assert.equal((await claude.workspace()).root, other);
  const explicit = new Session({ ...claude.options, workspace: f.root });
  assert.equal((await explicit.workspace()).root, f.root);
});

test('global stdio connection discovers MCP roots and exposes init without a token input', async t => {
  const f = await sessionFixture(t);
  const client = new Client({ name: 'roots-test', version: '1' }, { capabilities: { roots: { listChanged: true } } });
  client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: [{ uri: pathToFileURL(f.root).href }] }));
  const mockNetwork = path.join(f.root, 'mock-network.mjs');
  await writeFile(mockNetwork, `globalThis.fetch = async url => Response.json(url.endsWith('/pairings') ? ${JSON.stringify(startResponse())} : { status: 'pending' });`);
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', mockNetwork, path.resolve('dist/index.js'), '--dev', '--config-dir', f.configDir], env: { PATH: process.env.PATH, SUPPORTPAGES_TELEMETRY: '0' }, stderr: 'pipe' });
  await client.connect(transport); t.after(() => client.close());
  const result = await client.callTool({ name: 'supportpages_init', arguments: {} });
  assert.equal(result.structuredContent.result.workspace, f.root);
  assert.equal(result.structuredContent.result.status, 'authentication_required');
  const tools = await client.listTools();
  assert.ok(!JSON.stringify(tools.tools.find(tool => tool.name === 'supportpages_init').inputSchema).includes('token'));
});

test('revoked credentials return browser sign-in and empty roots do not fall back', async t => {
  const f = await sessionFixture(t);
  await authenticate({ 'api-url': origin, dev: true, 'config-dir': f.configDir }, { ui: { line: () => {}, secret: async () => token }, fetcher: settingsFetcher });
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('revoked', { status: 401 });
  try { assert.equal((await f.session.init({})).status, 'authentication_required'); }
  finally { globalThis.fetch = savedFetch; }
  f.session.roots = async () => [];
  await assert.rejects(f.session.workspace(), { code: 'workspace_required' });
});

test('authentication CLI rejects token arguments without echo and requires a user terminal', () => {
  const invalid = spawnSync(process.execPath, ['scripts/auth.mjs', `--token=${token}`], { encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.ok(!(invalid.stdout + invalid.stderr).includes(token));
  const noninteractive = spawnSync(process.execPath, ['scripts/auth.mjs'], { encoding: 'utf8' });
  assert.equal(noninteractive.status, 1);
  assert.match(noninteractive.stderr, /own interactive terminal/);
});
