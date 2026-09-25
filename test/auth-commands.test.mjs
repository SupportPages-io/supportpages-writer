import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Session, credentialLocation } from '../dist/session.js';
import { saveTokenFile, readTokenFile, readCredential } from '../dist/credentials.js';
import { environment, runCli } from '../scripts/lib/cli.mjs';
import { fixture } from './helpers.mjs';
import { Cancelled } from '../scripts/lib/terminal.mjs';

const origin = 'https://app.supportpages.io';
const token = 'sp_local_' + 'b'.repeat(64);
const nextToken = 'sp_local_' + 'd'.repeat(64);
const account = { id: '10', email: 'alice@example.com' };
const secret = 'c'.repeat(64), id = 'a'.repeat(64);
const start = () => ({ pairing_id: id, pairing_secret: secret, verification_uri: `${origin}/settings/mcp/connect/${id}`,
  user_code: 'ABCD-EFGH', expires_at: new Date(Date.now() + 600_000).toISOString(), interval: 3 });
const delivery = () => ({ status: 'authorized', api_origin: origin, account, token, scopes: ['read', 'import', 'projects:create'],
  token_expires_at: new Date(Date.now() + 90 * 86400_000).toISOString() });

async function setup(t, runtime) {
  const f = await fixture(t);
  const configDir = path.join(f.root, 'private-config');
  const skills = path.join(f.root, 'skills');
  await mkdir(path.join(skills, 'generate-illustrated-article'), { recursive: true });
  await writeFile(path.join(skills, 'generate-illustrated-article/SKILL.md'), 'test');
  const session = new Session({ workspace: f.root, cwd: f.root, origin, dev: false, skillsDir: '', configDir, pairingRuntime: runtime });
  const file = credentialLocation(origin, configDir).filename;
  const logs = [];
  const options = { workspace: f.root, 'config-dir': configDir, 'api-url': origin, 'skills-dir': skills };
  // Computer setup installs the coding-agent integration before choosing an account.
  const deps = { installRoot: path.resolve('.'), ui: { line: s => logs.push(s), ok: s => logs.push(s), note: s => logs.push(s), outro: s => logs.push(s), info: s => logs.push(s), confirm: async () => true },
    run: async cmd => ({ code: cmd === 'claude' ? 1 : 0 }), install: async () => ({ skillsDir: skills, clients: ['codex'] }), open: async () => true,
    env: { SUPPORTPAGES_DEV: undefined, SUPPORTPAGES_API_URL: undefined } };
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; session.close(); });
  return { ...f, session, configDir, skills, file, logs, options, deps };
}

test('logout revokes remotely, clears cached credentials and preserves folder links and other origins', async t => {
  const f = await setup(t);
  await saveTokenFile(f.file, origin, token, account);
  const otherOrigin = 'http://localhost:3000';
  const otherFile = credentialLocation(otherOrigin, f.configDir).filename;
  await saveTokenFile(otherFile, otherOrigin, nextToken);
  await f.ws.writeJson('.rtfm/supportpages/binding.json', { version: 1, api_origin: origin, project_id: '1' });
  await f.ws.write('output/article.md', 'Saved draft');
  const cached = await f.session.bridge();
  assert.equal(cached.api.configured(), true);
  const liveMcp = new Session(f.session.options);
  t.after(() => liveMcp.close());
  assert.equal((await liveMcp.bridge()).api.configured(), true);
  let requests = 0;
  globalThis.fetch = async (url, init) => {
    requests++;
    assert.equal(url, origin + '/api/v1/mcp/session');
    assert.equal(init.method, 'DELETE');
    assert.equal(init.headers.Authorization, `Bearer ${token}`);
    assert.equal(init.redirect, 'error');
    assert.equal(await readTokenFile(f.file, origin), token);
    return Response.json({ status: 'logged_out' });
  };
  await runCli({ ...f.options, command: 'logout' }, { ...f.deps, sessionFactory: () => f.session });
  assert.equal(requests, 1);
  await assert.rejects(stat(f.file), { code: 'ENOENT' });
  assert.equal((await liveMcp.bridge()).api.configured(), false);
  assert.equal(await readTokenFile(otherFile, otherOrigin), nextToken);
  assert.equal((await f.ws.json('.rtfm/supportpages/binding.json')).project_id, '1');
  assert.equal(await readFile(path.join(f.root, 'output/article.md'), 'utf8'), 'Saved draft');
  const fresh = new Session(f.session.options);
  t.after(() => fresh.close());
  assert.equal((await fresh.bridge()).api.configured(), false);
  assert.ok(!f.logs.join('\n').includes(token));
  assert.match(f.logs.join('\n'), /folder links/);
  const again = await fresh.logout();
  assert.equal(again.already_logged_out, true);
  assert.equal(requests, 1);
});

test('logout removes expired credentials but preserves a token when revocation fails', async t => {
  const f = await setup(t);
  for (const status of [500, 404, 429, 401]) {
    await saveTokenFile(f.file, origin, token);
    globalThis.fetch = async () => new Response('', { status });
    if (status === 401) {
      await f.session.logout();
      await assert.rejects(stat(f.file), { code: 'ENOENT' });
    } else {
      await assert.rejects(f.session.logout());
      assert.equal(await readTokenFile(f.file, origin), token);
    }
  }
  await saveTokenFile(f.file, origin, token);
  globalThis.fetch = async () => { throw Error('offline'); };
  await assert.rejects(f.session.logout(), { code: 'network_error' });
  assert.equal(await readTokenFile(f.file, origin), token);
  globalThis.fetch = async () => Response.json({ status: 'unexpected' });
  await assert.rejects(f.session.logout(), { code: 'invalid_response' });
  assert.equal(await readTokenFile(f.file, origin), token);
});

test('logout keeps a concurrent replacement and rejects explicit credential overrides', async t => {
  const f = await setup(t);
  await saveTokenFile(f.file, origin, token);
  globalThis.fetch = async () => { await saveTokenFile(f.file, origin, nextToken); return Response.json({ status: 'logged_out' }); };
  await assert.rejects(f.session.logout(), { code: 'connection_changed' });
  assert.equal(await readTokenFile(f.file, origin), nextToken);
  f.session.options.tokenFile = f.file;
  await assert.rejects(f.session.logout(), { code: 'invalid_configuration' });
  assert.equal(await readTokenFile(f.file, origin), nextToken);
});

test('login runs one browser sign-in and saves the device credential without touching the folder', async t => {
  const requests = [];
  const runtime = { now: Date.now, sleep: async () => {}, fetcher: async (url, init) => {
    requests.push(url);
    if (url.endsWith('/pairings')) {
      const body = JSON.parse(init.body);
      assert.equal(body.client_name, 'SupportPages Writer');
      // Every sign-in offers the full set; the approval page decides.
      assert.deepEqual(body.requested_scopes, ['read', 'import', 'projects:create', 'publish', 'manage', 'generate']);
      assert.ok(!body.workspace_name.includes('/'));
      return Response.json(start());
    }
    if (url.endsWith('/poll')) return Response.json({ status: 'approved' });
    if (url.endsWith('/exchange')) return Response.json(delivery());
    return Response.json({ status: 'completed' });
  } };
  const f = await setup(t, runtime);
  globalThis.fetch = async () => assert.fail('login must not call the API before a credential exists');
  let opened;
  const result = await runCli({ ...f.options, command: 'login' }, { ...f.deps, open: async url => { opened = url; return true; }, sessionFactory: () => f.session });
  assert.equal(result.status, 'signed_in');
  assert.deepEqual(result.account, account);
  assert.equal(opened, start().verification_uri);
  assert.deepEqual(await readCredential(f.file, origin), { token, account });
  assert.equal(await f.ws.exists('.rtfm/supportpages/binding.json'), false);
  assert.equal(await f.ws.exists('.rtfm/supportpages/setup/analysis.json'), false);
  await assert.rejects(stat(path.join(f.configDir, 'workspaces')), { code: 'ENOENT' });
  assert.match(f.logs.join('\n'), /ABCD-EFGH/);
  assert.match(f.logs.join('\n'), /Signed in as alice@example.com/);
  assert.ok(!f.logs.join('\n').includes(token)); assert.ok(!f.logs.join('\n').includes(secret));
  assert.equal(requests.length, 4);
  await assert.rejects(runCli({ ...f.options, command: 'login', project: '2' }, f.deps), { code: 'invalid_request' });
});

for (const mode of ['signin', 'signup']) test(`setup ${mode} completes browser approval without configuring the current folder`, async t => {
  const runtime = { now: Date.now, sleep: async () => {}, fetcher: async url => {
    if (url.endsWith('/pairings')) return Response.json(start());
    if (url.endsWith('/poll')) return Response.json({ status: 'approved' });
    if (url.endsWith('/exchange')) return Response.json(delivery());
    return Response.json({ status: 'completed' });
  } };
  const f = await setup(t, runtime);
  globalThis.fetch = async () => assert.fail('setup must not call the project API');
  f.deps.ui.choose = async (question, choices) => {
    assert.equal(question, 'How would you like to get started?');
    assert.deepEqual(choices, [
      { value: 'signin', label: 'Sign in to my existing SupportPages.io account' },
      { value: 'signup', label: 'Create a free SupportPages.io account and help centre' },
      { value: 'local', label: 'Save articles in my projects without an account' },
    ]);
    return mode;
  };
  let opened;
  const result = await runCli({ ...f.options, command: 'setup' }, { ...f.deps,
    open: async url => { opened = url; return mode !== 'signup'; }, sessionFactory: () => f.session });
  assert.equal(result.status, 'signed_in');
  assert.equal(opened, start().verification_uri + (mode === 'signup' ? '?signup=1' : ''));
  assert.deepEqual(await readCredential(f.file, origin), { token, account });
  assert.equal(await f.ws.exists('.rtfm'), false);
  await assert.rejects(stat(path.join(f.configDir, 'workspaces')), { code: 'ENOENT' });
  const logs = f.logs.join('\n');
  assert.ok(logs.includes(opened));
  assert.match(logs, /ABCD-EFGH/);
  assert.match(logs, /Run supportpages init in a project/);
  if (mode === 'signup') {
    assert.match(logs, /Create a free SupportPages.io account/);
    assert.match(logs, /Open the link above/);
  }
  assert.ok(!logs.includes(token)); assert.ok(!logs.includes(secret));
});

test('cancelling the setup choice opens no browser and leaves the project untouched', async t => {
  const runtime = { now: Date.now, sleep: async () => {}, fetcher: async url => {
    if (url.endsWith('/pairings')) return Response.json(start());
    assert.fail('Cancelled setup must not poll or exchange credentials');
  } };
  const f = await setup(t, runtime);
  await f.ws.writeJson('.rtfm/supportpages/binding.json', { project_id: '1' });
  f.deps.ui.choose = async () => { throw new Cancelled(); };
  f.deps.open = async () => assert.fail('Cancelled setup must not open a browser');
  await assert.rejects(runCli({ ...f.options, command: 'setup' }, { ...f.deps, sessionFactory: () => f.session }), Cancelled);
  await assert.rejects(stat(f.file), { code: 'ENOENT' });
  assert.deepEqual(await f.ws.json('.rtfm/supportpages/binding.json'), { project_id: '1' });
});

test('repeated setup reuses a valid credential and points to project initialization', async t => {
  const f = await setup(t);
  await saveTokenFile(f.file, origin, token, account);
  globalThis.fetch = async url => {
    assert.equal(url, origin + '/api/v1/mcp/settings');
    return Response.json({ account });
  };
  f.deps.ui.choose = async () => assert.fail('Already signed-in setup does not ask to sign in again');
  f.deps.open = async () => assert.fail('Already signed-in setup does not open a browser');
  const result = await runCli({ ...f.options, command: 'setup' }, { ...f.deps, sessionFactory: () => f.session });
  assert.equal(result.already_signed_in, true);
  assert.match(f.logs.join('\n'), /Already signed in as alice@example.com/);
  assert.match(f.logs.join('\n'), /Run supportpages init in a project/);
});

test('repeated login reuses a valid credential, and cancellation saves nothing', async t => {
  let starts = 0;
  const runtime = { now: Date.now, sleep: () => new Promise(() => {}), fetcher: async url => {
    if (url.endsWith('/pairings')) { starts++; return Response.json(start()); }
    assert.fail('cancelled sign-in must not poll');
  } };
  const f = await setup(t, runtime);
  await saveTokenFile(f.file, origin, token, account);
  globalThis.fetch = async (url, init) => {
    assert.equal(url, origin + '/api/v1/mcp/settings');
    assert.equal(init.headers.Authorization, `Bearer ${token}`);
    return Response.json({ account, preferences: {} });
  };
  const reused = await runCli({ ...f.options, command: 'login' }, { ...f.deps, sessionFactory: () => f.session });
  assert.equal(reused.already_signed_in, true);
  assert.equal(starts, 0);
  assert.match(f.logs.join('\n'), /Already signed in as alice@example.com/);
  globalThis.fetch = async () => new Response('', { status: 401 });
  await assert.rejects(runCli({ ...f.options, command: 'login' }, { ...f.deps, open: async () => { f.session.close(); return true; }, sessionFactory: () => f.session }), Cancelled);
  assert.equal(starts, 1);
  assert.equal(await readTokenFile(f.file, origin), token);
});

test('help lists login/logout, login needs a terminal, and logout works unattended when already signed out', async t => {
  const f = await setup(t);
  const help = spawnSync(process.execPath, ['scripts/cli.mjs', '--help'], { encoding: 'utf8' });
  assert.match(help.stdout, /setup\s+One-time setup for this computer/);
  assert.match(help.stdout, /init\s+Set up this project/);
  assert.match(help.stdout, /login\s+Sign in/);
  assert.match(help.stdout, /logout\s+Sign out/);
  const login = spawnSync(process.execPath, ['scripts/cli.mjs', 'login'], { encoding: 'utf8' });
  assert.equal(login.status, 2);
  assert.match(login.stderr, /interactive terminal/);
  const accountSetup = spawnSync(process.execPath, ['scripts/cli.mjs', 'setup'], { encoding: 'utf8' });
  assert.equal(accountSetup.status, 2);
  assert.match(accountSetup.stderr, /Run supportpages setup in an interactive terminal/);
  const logout = spawnSync(process.execPath, ['scripts/cli.mjs', 'logout', '--workspace', f.root, '--config-dir', f.configDir, '--api-url', origin], { encoding: 'utf8' });
  assert.equal(logout.status, 0, logout.stderr);
  assert.match(logout.stdout, /already signed out/);
});

test('device authentication defaults to production despite a saved development workspace', async t => {
  const f = await setup(t);
  const profile = path.join(f.configDir, 'workspaces', createHash('sha256').update(f.root).digest('hex') + '.json');
  await mkdir(path.dirname(profile), { recursive: true });
  const saved = JSON.stringify({ version: 1, workspace: f.root, origin: 'http://app.lvh.me:4000', dev: true });
  await writeFile(profile, saved);
  const cases = [
    { options: {}, env: {}, origin, dev: false },
    { options: { dev: true }, env: {}, origin: 'https://app.lvh.me:3443', dev: true },
    { options: { dev: true, 'api-url': 'http://app.lvh.me:4000' }, env: {}, origin: 'http://app.lvh.me:4000', dev: true },
    { options: { 'api-url': 'https://staging.example' }, env: {}, origin: 'https://staging.example', dev: false },
    { options: {}, env: { SUPPORTPAGES_DEV: 'true' }, origin: 'https://app.lvh.me:3443', dev: true },
    { options: {}, env: { SUPPORTPAGES_API_URL: 'https://staging.example' }, origin: 'https://staging.example', dev: false },
    { options: { 'api-url': origin }, env: { SUPPORTPAGES_API_URL: 'https://staging.example' }, origin, dev: false },
  ];
  for (const command of ['setup', 'login', 'logout']) for (const scenario of cases) {
    let selected;
    await runCli({ command, workspace: f.root, 'config-dir': f.configDir, ...scenario.options }, {
      ...f.deps, env: { ...f.deps.env, ...scenario.env },
      sessionFactory: config => {
        selected = config;
        return { login: async () => ({ status: 'signed_in', account, already_signed_in: true }), account: async () => account,
          workspace: async () => f.ws, logout: async () => ({ already_logged_out: true }), close() {} };
      },
    });
    assert.equal(selected.origin, scenario.origin);
    assert.equal(selected.dev, scenario.dev);
    assert.equal(await readFile(profile, 'utf8'), saved);
  }
  // Project commands continue using the saved development server.
  for (const command of ['init', 'status', 'write']) {
    const config = await environment(f.root, { command, 'config-dir': f.configDir }, {});
    assert.equal(config.origin, 'http://app.lvh.me:4000');
    assert.equal(config.dev, true);
  }
  assert.match(f.logs.join('\n'), /supportpages logout --dev --api-url 'http:\/\/app.lvh.me:4000'/);
  assert.match(f.logs.join('\n'), /supportpages login --dev --api-url 'http:\/\/app.lvh.me:4000'/);
  // A broken project profile must not prevent independent device authentication.
  await writeFile(profile, 'invalid json');
  for (const command of ['setup', 'login', 'logout']) {
    assert.equal((await environment(f.root, { command, 'config-dir': f.configDir }, {})).origin, origin);
  }
});

test('setup can choose local articles: no pairing, no browser, a device preference and guidance for init', async t => {
  const runtime = { now: Date.now, sleep: async () => {}, fetcher: async url => assert.fail(`Local setup must not contact the service: ${url}`) };
  const f = await setup(t, runtime);
  globalThis.fetch = async () => assert.fail('Local setup must not call the API');
  f.deps.ui.choose = async question => { assert.equal(question, 'How would you like to get started?'); return 'local'; };
  f.deps.open = async () => assert.fail('Local setup must not open a browser');
  const result = await runCli({ ...f.options, command: 'setup' }, { ...f.deps, sessionFactory: () => f.session });
  assert.deepEqual(result, { status: 'local', api_origin: origin, already_signed_in: false });
  await assert.rejects(stat(f.file), { code: 'ENOENT' });
  assert.equal(await f.ws.exists('.rtfm'), false);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.configDir, 'preferences.json'), 'utf8')), { version: 1, default_destination: 'local' });
  assert.equal((await stat(path.join(f.configDir, 'preferences.json'))).mode & 0o077, 0);
  const logs = f.logs.join('\n');
  assert.match(logs, /A help centre gives articles a public URL/, 'the difference is stated before the choice');
  assert.match(logs, /No account needed: articles will be saved in your projects/);
  assert.match(logs, /Account: none — articles are saved in your projects/);
  assert.match(logs, /Run supportpages init in a project to set up writing/);
  assert.match(logs, /set up writing\.\nOptional: supportpages publish hosts saved articles on a help centre later\./);
  assert.doesNotMatch(logs, /Next: /, 'the outro gives the next step once');
});

test('explicit permission upgrade requests browser consent and denial keeps the old credential',async t=>{
  let now=Date.now(), requested;
  const runtime={now:()=>now,sleep:async ms=>{now+=ms;},fetcher:async(url,init)=>{
    if(url.endsWith('/pairings')){requested=JSON.parse(init.body).requested_scopes;return Response.json(start());}
    if(url.endsWith('/poll'))return Response.json({status:'denied'});
    assert.fail('denied permission request must not exchange credentials');
  }};
  const f=await setup(t,runtime);await saveTokenFile(f.file,origin,token,account);
  globalThis.fetch=async()=>Response.json({account,scopes:['read','import','projects:create','publish']});
  let approval=false;
  await assert.rejects(f.session.login({scopes:['manage'],onApproval:async()=>{approval=true;assert.equal(await readTokenFile(f.file,origin),token);}}),{code:'authorization_denied'});
  assert.equal(approval,true);assert.deepEqual(requested,['read','import','projects:create','publish','manage','generate']);
  assert.equal(await readTokenFile(f.file,origin),token);
});
