import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { automaticUpdate, CHECK_INTERVAL } from '../scripts/lib/auto-update.mjs';
import { updateCli } from '../scripts/lib/update.mjs';
import { autoUpdateEnabled, pinSkills, startBackgroundUpdate } from '../dist/runtime.js';

async function engineAt(directory) {
  for (const skill of ['detect-project', 'generate-illustrated-article']) {
    await mkdir(path.join(directory, skill), { recursive: true });
    await writeFile(path.join(directory, skill, 'SKILL.md'), 'fixture');
  }
}

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "supportpages auto update ' ")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const installRoot = path.join(root, 'versions/0.1.0/mcp');
  await engineAt(path.join(installRoot, 'engine'));
  await writeFile(path.join(installRoot, 'package.json'), JSON.stringify({ type: 'module', version: '0.1.0' }));
  await symlink('versions/0.1.0', path.join(root, 'current'));
  const receipt = { version: 1, type: 'release', data_dir: root, bin_dir: path.join(root, 'bin'), release_url: 'https://downloads.example/cli' };
  const save = value => writeFile(path.join(root, 'install.json'), JSON.stringify(value));
  await save(receipt);
  let time = Date.now();
  const calls = [];
  const options = { installRoot, env: {}, now: () => time, update: async value => { calls.push(value); } };
  return { root, installRoot, receipt, save, calls, options, advance: amount => { time += amount; } };
}

test('automatic checks share a rolling 24-hour interval and manual updates bypass it', async t => {
  const f = await fixture(t);
  await automaticUpdate(f.options);
  f.advance(CHECK_INTERVAL - 1);
  await automaticUpdate(f.options);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].checkTimeout, 5);
  assert.equal(f.calls[0].env.SUPPORTPAGES_CLI_HOME, path.join(f.root, 'current'));
  f.advance(1);
  await automaticUpdate(f.options);
  assert.equal(f.calls.length, 2);
  let checked = 0;
  await updateCli({ installRoot: f.installRoot, env: f.calls[0].env, ui: { line() {} },
    run: async () => { checked++; return { code: 0, stdout: '0.1.0' }; } });
  assert.equal(checked, 1);
});

test('concurrent agent startups run only one update and failures are also throttled', async t => {
  const f = await fixture(t);
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  let attempts = 0;
  f.options.update = async () => { attempts++; await pending; throw Error('offline'); };
  const first = automaticUpdate(f.options);
  while (!attempts) await delay(5);
  await Promise.all(Array.from({ length: 20 }, () => automaticUpdate(f.options)));
  assert.equal(attempts, 1);
  finish(); await first;
  await automaticUpdate(f.options);
  assert.equal(attempts, 1);
  assert.equal((await readFile(path.join(f.root, 'install.json'), 'utf8')), JSON.stringify(f.receipt));
});

test('opt-out, CI, local builds and invalid installations never check or install', async t => {
  for (const env of [{ SUPPORTPAGES_AUTO_UPDATE: '0' }, { SUPPORTPAGES_AUTO_UPDATE: 'false' }, { SUPPORTPAGES_AUTO_UPDATE: 'off' }, { CI: 'true' }]) {
    const f = await fixture(t);
    await automaticUpdate({ ...f.options, env });
    assert.equal(f.calls.length, 0);
  }
  assert.equal(autoUpdateEnabled({ CI: 'false' }), true);
  for (const override of [{ type: 'local' }, { release_url: 'http://insecure.example' }, { data_dir: '/elsewhere' }]) {
    const f = await fixture(t);
    await f.save({ ...f.receipt, ...override });
    await automaticUpdate(f.options);
    assert.equal(f.calls.length, 0);
  }
  const f = await fixture(t);
  await automaticUpdate({ ...f.options, installRoot: '/source/checkout' });
  await rm(path.join(f.root, 'install.json'));
  await automaticUpdate(f.options);
  assert.equal(f.calls.length, 0);
});

test('abandoned locks recover without allowing simultaneous daily checks', async t => {
  const f = await fixture(t);
  const lock = path.join(f.root, '.auto-update.lock');
  await mkdir(lock);
  const old = new Date(Date.now() - 2 * CHECK_INTERVAL);
  await utimes(lock, old, old);
  await Promise.all(Array.from({ length: 20 }, () => automaticUpdate(f.options)));
  assert.equal(f.calls.length, 1);
});

test('a running session keeps its engine and the next session uses the new bundled engine', async t => {
  const f = await fixture(t);
  const next = path.join(f.root, 'versions/0.2.0/mcp');
  await engineAt(path.join(next, 'engine'));
  const stable = path.join(f.root, 'current/mcp/engine');
  const pinned = await pinSkills(f.installRoot, stable);
  assert.equal(pinned, path.join(f.installRoot, 'engine'));
  await symlink('versions/0.2.0', path.join(f.root, 'next'));
  await rename(path.join(f.root, 'next'), path.join(f.root, 'current'));
  assert.equal(pinned, path.join(f.installRoot, 'engine'));
  assert.equal(await pinSkills(next, stable), path.join(next, 'engine'));
  // Old installations registered these physical paths; migrate them at startup.
  assert.equal(await pinSkills(next, pinned), path.join(next, 'engine'));
  assert.equal(await pinSkills(next, path.join(f.root, 'current/mcp/skills')), path.join(next, 'engine'));
  assert.equal(await pinSkills(next, path.join(f.installRoot, 'skills')), path.join(next, 'engine'));
  // A skills copy in the shared data directory (beside cli/) maps to the engine too.
  const sharedCopy = path.join(path.dirname(f.root), 'skills', 'v1.53.0');
  assert.equal(await pinSkills(next, sharedCopy), path.join(next, 'engine'));
  const external = path.join(f.root, 'custom-skills');
  await mkdir(external);
  assert.equal(await pinSkills(next, external), external);
  await automaticUpdate(f.options);
  assert.equal(f.calls.length, 0, 'old servers cannot update a different active release');
});

test('worker startup disconnects all protocol streams and never throws into the server', () => {
  let launches = 0, unreferenced = false;
  const spawn = (_node, args, options) => {
    launches++;
    assert.equal(options.stdio, 'ignore');
    assert.equal(options.detached, true);
    assert.equal(options.env.SUPPORTPAGES_API_TOKEN, undefined);
    assert.equal(args[0], '/managed/versions/0.1.0/mcp/scripts/auto-update.mjs');
    return { on() {}, unref() { unreferenced = true; } };
  };
  startBackgroundUpdate('/managed/versions/0.1.0/mcp', { SUPPORTPAGES_API_TOKEN: 'private' }, spawn);
  assert.equal(unreferenced, true);
  startBackgroundUpdate('/source/checkout', {}, spawn);
  startBackgroundUpdate('/managed/versions/0.1.0/mcp', { SUPPORTPAGES_AUTO_UPDATE: '0' }, spawn);
  assert.equal(launches, 1);
  assert.doesNotThrow(() => startBackgroundUpdate('/managed/versions/0.1.0/mcp', {}, () => { throw Error('spawn failed'); }));
});

test('a real MCP connection remains usable while an independent worker emits output', async t => {
  const f = await fixture(t);
  await cp('dist', path.join(f.installRoot, 'dist'), { recursive: true });
  await symlink(path.resolve('node_modules'), path.join(f.installRoot, 'node_modules'));
  await mkdir(path.join(f.installRoot, 'scripts'));
  const marker = path.join(f.installRoot, 'worker-finished');
  await writeFile(path.join(f.installRoot, 'scripts/auto-update.mjs'), `
    import {writeFile} from 'node:fs/promises';
    process.stdout.write('This must never appear on the MCP transport\\n');
    process.stderr.write('This must never reach the agent\\n');
    setTimeout(async () => { await writeFile('worker-finished', 'done'); }, 700);
  `);
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.join(f.root, 'current/mcp/dist/index.js'), '--skills-dir', path.join(f.root, 'current/mcp/engine')],
    env: { ...process.env, CI: '', SUPPORTPAGES_AUTO_UPDATE: '1' }, stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += chunk; });
  const client = new Client({ name: 'automatic-update-test', version: '1' });
  t.after(() => client.close());
  await client.connect(transport);
  assert.ok((await client.listTools()).tools.length > 0);
  await assert.rejects(readFile(marker), { code: 'ENOENT' }, 'handshake does not wait for the worker');
  for (let i = 0; i < 100; i++) {
    try { if (await readFile(marker, 'utf8') === 'done') break; } catch {}
    await delay(25);
  }
  assert.equal(await readFile(marker, 'utf8'), 'done');
  assert.ok((await client.listTools()).tools.length > 0);
  assert.equal(stderr, '');
});

test('an update to a release without an engine keeps the registered skills', async t => {
  const f = await fixture(t);
  const next = path.join(f.root, 'versions/0.2.0/mcp');
  await mkdir(next, { recursive: true });
  const previous = path.join(f.installRoot, 'skills');
  await mkdir(previous);
  assert.equal(await pinSkills(next, previous), previous);
  await engineAt(path.join(next, 'engine'));
  assert.equal(await pinSkills(next, previous), path.join(next, 'engine'));
});

test('updates prepare Chromium for the new release only when the renderer was used, and stop on failure', async t => {
  const { prepareUpdate } = await import('../scripts/lib/prepare-update.mjs');
  const f = await fixture(t);
  const next = path.join(f.root, 'versions/0.2.0/mcp');
  await engineAt(path.join(next, 'engine'));
  const previous = path.join(f.root, 'versions/unused/mcp');
  await mkdir(previous, { recursive: true });
  const calls = [];
  const options = { home: f.root, env: {}, run: async (...args) => { calls.push(args); return { code: 0 }; } };
  await prepareUpdate(previous, next, options);
  assert.equal(calls.length, 0, 'never downloads Chromium for an unused installation');
  // The previous release rendered (its Chromium check passes): prepare the next one.
  await prepareUpdate(f.installRoot, next, options);
  assert.equal(calls.length, 2);
  assert.ok(calls[0][1].includes(path.join(f.installRoot, 'engine', 'generate-illustrated-article')));
  assert.equal(calls[1][0], path.resolve(next, '../runtime/bin/node'));
  // When the next release's Chromium is missing and cannot be downloaded, the update stops.
  const previousOnly = async (_node, args) => ({ code: args.includes(path.join(f.installRoot, 'engine', 'generate-illustrated-article')) ? 0 : 1, stdout: '' });
  await assert.rejects(prepareUpdate(f.installRoot, next, { ...options, run: previousOnly }), /current release is still active/);
  // A previous release whose Chromium was never downloaded is not prepared.
  await prepareUpdate(f.installRoot, next, { ...options, run: async () => ({ code: 1, stdout: '' }) });
});
