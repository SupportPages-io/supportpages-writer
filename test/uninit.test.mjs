import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './helpers.mjs';
import { runCli, environment } from '../scripts/lib/cli.mjs';
import { uninitWorkspace } from '../scripts/lib/uninit.mjs';
import { Cancelled } from '../scripts/lib/terminal.mjs';

const state = '.rtfm/supportpages';
const httpsState = `${state}/dev/96c6658f03787074`;
const httpState = `${state}/dev/f66b1389b7f545cc`;
const ui = { line() {}, ok() {}, confirm: async () => true };
async function setup(t) {
  const f = await fixture(t);
  const config = path.join(f.root, 'config');
  const profile = path.join(config, 'workspaces', createHash('sha256').update(f.root).digest('hex') + '.json');
  await mkdir(path.dirname(profile), { recursive: true });
  await writeFile(profile, JSON.stringify({ version: 1, workspace: f.root, origin: 'https://app.lvh.me:3443', dev: true }));
  await f.ws.writeJson(`${httpsState}/binding.json`, { project_id: '92', api_origin: 'https://app.lvh.me:3443' });
  await f.ws.writeJson(`${httpState}/binding.json`, { project_id: '89', api_origin: 'http://app.lvh.me:3000' });
  return { ...f, config, profile };
}

test('uninit clears both dev bindings and the remembered environment, preserving recovery and other data offline', async t => {
  const f = await setup(t);
  const oldProfile = await readFile(f.profile);
  await f.ws.writeJson(`${state}/binding.json`, { project_id: '1' });
  await f.ws.writeJson(`${state}/local.json`, { version: 1, export_dir: 'output/articles' });
  await f.ws.writeJson(`${httpsState}/operations/92/latest.json`, { operation_id: '123' });
  await f.ws.write(`${state}/archives/previous/saved.txt`, 'old backup');
  await f.ws.write('output/articles/example/index.md', 'keep article');
  await f.ws.write('.rtfm/project_map.json', 'keep analysis');
  await f.ws.write('config/credentials/example.json', 'keep sign-in');
  await f.ws.write('config/workspaces/unrelated.json', 'keep another project');
  const before = await environment(f.root, { 'config-dir': f.config }, {});
  assert.equal(before.dev, true);
  const result = await runCli({ command: 'uninit', workspace: f.root, 'config-dir': f.config }, {
    installRoot: path.resolve('.'), ui, sessionFactory: () => assert.fail('No authentication, relay or remote API should start'), run: () => assert.fail('No agent should start'),
  });
  assert.equal(result.status, 'uninitialized');
  assert.equal(await f.ws.exists(`${state}/dev`), false);
  assert.equal(await f.ws.exists(`${state}/binding.json`), false);
  assert.equal(await f.ws.exists(`${state}/local.json`), false);
  await assert.rejects(readFile(f.profile), { code: 'ENOENT' });
  assert.deepEqual(await readFile(path.join(result.archive, 'workspace-profile.json')), oldProfile);
  assert.equal(JSON.parse(await readFile(path.join(result.archive, 'dev/96c6658f03787074/binding.json'))).project_id, '92');
  assert.equal(JSON.parse(await readFile(path.join(result.archive, 'dev/f66b1389b7f545cc/binding.json'))).project_id, '89');
  assert.equal(JSON.parse(await readFile(path.join(result.archive, 'dev/96c6658f03787074/operations/92/latest.json'))).operation_id, '123');
  for (const [filename, value] of [['output/articles/example/index.md', 'keep article'], ['.rtfm/project_map.json', 'keep analysis'], ['config/credentials/example.json', 'keep sign-in'], ['config/workspaces/unrelated.json', 'keep another project'], [`${state}/archives/previous/saved.txt`, 'old backup']]) {
    assert.equal((await f.ws.read(filename)).toString(), value);
  }
  const after = await environment(f.root, { 'config-dir': f.config }, {});
  assert.equal(after.dev, false);
  assert.equal(after.origin, 'https://app.supportpages.io');
  assert.equal((await uninitWorkspace(f.root, f.config, { ui })).already_uninitialized, true);
});

test('uninit can recover from a corrupt workspace profile without parsing it', async t => {
  const f = await setup(t);
  await writeFile(f.profile, 'broken JSON');
  const result = await uninitWorkspace(f.root, f.config, { ui, yes: true });
  assert.equal(await readFile(path.join(result.archive, 'workspace-profile.json'), 'utf8'), 'broken JSON');
  assert.equal(await f.ws.exists(`${state}/dev`), false);
});

test('cancelling uninit leaves the profile, bindings and archive untouched', async t => {
  const f = await setup(t);
  await assert.rejects(uninitWorkspace(f.root, f.config, { ui: { ...ui, confirm: async () => false } }), Cancelled);
  assert.equal(await f.ws.exists(`${httpsState}/binding.json`), true);
  assert.equal(await f.ws.exists(`${state}/archives`), false);
  assert.equal((await environment(f.root, { 'config-dir': f.config }, {})).dev, true);
});

test('uninit refuses active writers and analysis in either environment', async t => {
  const f = await setup(t);
  const run = { id: randomUUID(), local_article_id: randomUUID(), artifact_dir: 'output/articles/example', started_at: new Date().toISOString(), section_id: null, status: 'prepared', skills_version: '1.0.0' };
  await f.ws.writeJson(`${httpState}/active-run.json`, run);
  await assert.rejects(uninitWorkspace(f.root, f.config, { ui }), { code: 'generation_active' });
  await f.ws.writeJson(`${httpState}/active-run.json`, { ...run, status: 'cancelled' });
  for (const root of [state, httpState, httpsState]) {
    await f.ws.writeJson(`${root}/setup/task.json`, { status: 'running' });
    await assert.rejects(uninitWorkspace(f.root, f.config, { ui }), { code: 'workspace_busy' });
    await f.ws.writeJson(`${root}/setup/task.json`, { status: 'completed' });
  }
  assert.equal(await f.ws.exists(`${state}/archives`), false);
  assert.equal((await environment(f.root, { 'config-dir': f.config }, {})).dev, true);
});

test('uninit detects a changed profile during confirmation', async t => {
  const f = await setup(t);
  const changed = JSON.stringify({ version: 1, workspace: f.root, dev: false, origin: 'https://app.supportpages.io' });
  await assert.rejects(uninitWorkspace(f.root, f.config, { ui: { ...ui, confirm: async () => { await writeFile(f.profile, changed); return true; } } }), { code: 'configuration_changed' });
  assert.equal(await readFile(f.profile, 'utf8'), changed);
  assert.equal(await f.ws.exists(`${httpsState}/binding.json`), true);
});

test('a move failure restores earlier state moves and keeps the workspace profile', async t => {
  const f = await setup(t);
  await f.ws.writeJson(`${state}/binding.json`, { project_id: '1' });
  await symlink(path.join(f.root, 'config'), path.join(f.root, state, 'z-external'));
  await assert.rejects(uninitWorkspace(f.root, f.config, { ui }), { code: 'invalid_path' });
  assert.equal((await f.ws.json(`${state}/binding.json`)).project_id, '1');
  assert.equal((await f.ws.json(`${httpsState}/binding.json`)).project_id, '92');
  assert.equal((await environment(f.root, { 'config-dir': f.config }, {})).dev, true);
});

test('the terminal accepts uninit --yes offline and rejects environment-specific removal', async t => {
  const f = await setup(t);
  const args = ['scripts/cli.mjs', 'uninit', '--workspace', f.root, '--config-dir', f.config, '--yes'];
  const blocked = spawnSync(process.execPath, [...args, '--dev'], { encoding: 'utf8' });
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /Omit --dev and --api-url/);
  assert.equal(await f.ws.exists(`${httpsState}/binding.json`), true);
  const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Project setup removed/);
  assert.equal(await f.ws.exists(`${httpsState}/binding.json`), false);
  assert.equal((await environment(f.root, { 'config-dir': f.config }, {})).dev, false);
});
