import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { compareVersions, updateCli } from '../scripts/lib/update.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "supportpages update ' "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const installRoot = path.join(root, 'versions/0.1.0/mcp');
  await mkdir(installRoot, { recursive: true });
  await writeFile(path.join(installRoot, 'package.json'), JSON.stringify({ version: '0.1.0' }));
  await symlink('versions/0.1.0', path.join(root, 'current'));
  const receipt = { version: 1, type: 'release', data_dir: root, bin_dir: path.join(root, 'custom bin'), release_url: 'https://downloads.example/cli' };
  const save = value => writeFile(path.join(root, 'install.json'), JSON.stringify(value));
  await save(receipt);
  const logs = [], calls = [];
  const deps = { installRoot, env: { SUPPORTPAGES_CLI_HOME: path.join(root, 'current'), SUPPORTPAGES_CLI_RELEASE_URL: 'https://ignored.example' },
    ui: { line: text => logs.push(text) }, run: async (...args) => { calls.push(args); return { code: 0, stdout: '0.2.0\n' }; } };
  return { root, receipt, save, logs, calls, deps };
}

test('update preserves saved locations and origin, using the bundled installer without a workspace', async t => {
  const f = await fixture(t);
  assert.deepEqual(await updateCli(f.deps), { status: 'updated', version: '0.2.0' });
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0][0], 'curl');
  assert.equal(f.calls[0][1].at(-1), 'https://downloads.example/cli/latest.txt');
  assert.deepEqual(f.calls[1][1], [path.join(f.deps.installRoot, 'install-cli.sh'), '--yes', '--update', '--version', '0.2.0', '--data-dir', f.root, '--bin-dir', f.receipt.bin_dir]);
  assert.equal(f.calls[1][2].env.SUPPORTPAGES_CLI_RELEASE_URL, f.receipt.release_url);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.root, 'install.json'))), f.receipt);
});

test('version comparison is numeric and rejects malformed release pointers', async () => {
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('0.9.9', '1.0.0'), -1);
  for (const version of ['1.0', 'v1.0.0', '1.0.0\nnext', '1.0.0-beta']) assert.throws(() => compareVersions('1.0.0', version), /version must be/);
});

test('equal and older releases never invoke the installer', async t => {
  for (const version of ['0.1.0', '0.0.9']) {
    const f = await fixture(t);
    f.deps.run = async executable => { assert.equal(executable, 'curl'); return { code: 0, stdout: version }; };
    assert.equal((await updateCli(f.deps)).status, 'current');
  }
});

test('missing, malformed and mismatched receipts stop before any download', async t => {
  for (const override of [null, { version: 2 }, { data_dir: '/elsewhere' }, { release_url: 'http://insecure.example' }, { release_url: 'https://user:secret@example.com' }, { bin_dir: 'relative' }]) {
    const f = await fixture(t);
    if (override) await f.save({ ...f.receipt, ...override }); else await rm(path.join(f.root, 'install.json'));
    await assert.rejects(updateCli(f.deps), /original --data-dir and --bin-dir/);
    assert.equal(f.calls.length, 0);
  }
});

test('source installations cannot silently switch to public releases', async t => {
  const f = await fixture(t);
  await f.save({ ...f.receipt, type: 'local' });
  await assert.rejects(updateCli(f.deps), /local development build/);
  delete f.deps.env.SUPPORTPAGES_CLI_HOME;
  await assert.rejects(updateCli(f.deps), /source or unmanaged/);
  assert.equal(f.calls.length, 0);
});

test('download, invalid pointer and installation failures report retry guidance', async t => {
  const f = await fixture(t);
  f.deps.run = async () => ({ code: 22 });
  await assert.rejects(updateCli(f.deps), /Could not check for updates/);
  f.deps.run = async () => ({ code: 0, stdout: '<html>Unavailable</html>' });
  await assert.rejects(updateCli(f.deps), /version must be/);
  f.deps.run = async executable => executable === 'curl' ? { code: 0, stdout: '0.2.0' } : { code: 1 };
  await assert.rejects(updateCli(f.deps), /previous version remains available/);
});

test('update runs unattended and rejects project flags before installation work', () => {
  const env = { ...process.env }; delete env.SUPPORTPAGES_CLI_HOME;
  const run = args => spawnSync(process.execPath, ['scripts/cli.mjs', 'update', ...args], { env, encoding: 'utf8' });
  const unmanaged = run([]);
  assert.equal(unmanaged.status, 1);
  assert.match(unmanaged.stderr, /source or unmanaged/);
  assert.doesNotMatch(unmanaged.stderr, /interactive terminal/);
  for (const args of [['--workspace', '/missing'], ['--dev'], ['--agent', 'codex'], ['--yes'], ['extra']]) {
    const result = run(args);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Invalid command/);
  }
});
