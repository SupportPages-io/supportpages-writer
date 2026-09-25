#!/usr/bin/env node
// Exercise real release payloads with only base shell tools on the client's PATH.
// A local curl stand-in supplies release downloads; no public release is needed.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const { values } = parseArgs({ options: { directory: { type: 'string' } } });
const directory = path.resolve(values.directory ?? 'release');
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const suffix = `-${process.platform}-${process.arch}.tar.gz`;
const archive = (await readdir(directory)).find(name => name.endsWith(suffix));
assert.ok(archive, `Missing ${suffix} release`);
const temporary = await mkdtemp(path.join(os.tmpdir(), "supportpages smoke ' "));
const checked = (executable, args, options = {}) => {
  const result = spawnSync(executable, args, { encoding: 'utf8', timeout: 120_000, ...options });
  assert.equal(result.status, 0, `${executable} failed: ${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
};
try {
  const downloads = path.join(temporary, 'downloads');
  const unpacked = path.join(temporary, 'unpacked');
  const baseTools = path.join(temporary, 'base-tools');
  const home = path.join(temporary, 'home');
  for (const folder of [downloads, unpacked, baseTools, home]) await mkdir(folder);
  for (const name of ['bash', 'tar', 'gzip', 'awk', 'sed', 'uname', 'mktemp', 'rm', 'rmdir', 'dirname', 'basename', 'cp', 'mkdir', 'chmod', 'cat', 'mv', 'ln', 'shasum', 'sha256sum']) {
    const executable = spawnSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
    if (executable.status === 0) await symlink(executable.stdout.trim(), path.join(baseTools, name));
  }
  await writeFile(path.join(baseTools, 'curl'), `#!/bin/sh
url= output=
while [ "$#" -gt 0 ]; do
  case "$1" in https://*) url="$1" ;; -o) shift; output="$1" ;; esac
  shift
done
case "$url" in
  https://downloads.example/cli/latest.txt) printf '%s\\n' "$SMOKE_LATEST" ;;
  https://downloads.example/cli/*) cp "$SMOKE_DOWNLOADS/$(basename -- "$url")" "$output" ;;
  *) exit 22 ;;
esac
`, { mode: 0o755 });
  await cp(path.join(directory, archive), path.join(downloads, archive));
  await cp(path.join(directory, archive + '.sha256'), path.join(downloads, archive + '.sha256'));
  checked('tar', ['-xzf', path.join(directory, archive), '-C', unpacked]);
  const pkg = path.join(unpacked, 'supportpages/mcp/package.json');
  const metadata = JSON.parse(await readFile(pkg, 'utf8'));
  const version = metadata.version;
  assert.notEqual(version, '0.0.0', 'Smoke upgrade needs a release newer than 0.0.0');
  await writeFile(pkg, JSON.stringify({ ...metadata, version: '0.0.0' }));
  const previous = path.join(downloads, `supportpages-0.0.0${suffix}`);
  checked('tar', ['-czf', previous, '-C', unpacked, 'supportpages']);
  await writeFile(previous + '.sha256', `${createHash('sha256').update(await readFile(previous)).digest('hex')}  ${path.basename(previous)}\n`);
  const env = { ...process.env, HOME: home, PATH: baseTools, SHELL: '/bin/bash',
    SUPPORTPAGES_CLI_RELEASE_URL: 'https://downloads.example/cli', SMOKE_DOWNLOADS: downloads, SMOKE_LATEST: '0.0.0' };
  delete env.SUPPORTPAGES_CLI_HOME;
  delete env.SUPPORTPAGES_API_TOKEN;
  delete env.SUPPORTPAGES_API_TOKEN_FILE;
  const data = path.join(temporary, 'custom data'), bin = path.join(temporary, 'custom bin');
  const installer = await readFile(path.join(sourceRoot, 'install-cli.sh'), 'utf8');
  checked('bash', ['-s', '--', '--yes', '--data-dir', data, '--bin-dir', bin], { input: installer, env });
  const cli = path.join(bin, 'supportpages');
  const checkTools = () => {
    const release = path.join(data, 'current');
    checked(path.join(release, 'runtime/bin/node'), [path.join(release, 'mcp/scripts/check-runtime.mjs')], {
      env: { ...env, PATH: '' },
    });
    const doctor = JSON.parse(checked(path.join(release, 'runtime/bin/node'), [path.join(release, 'mcp/dist/index.js'), '--doctor', '--workspace', home], { env }));
    // Git is a system prerequisite and may be absent from this minimal PATH; Node is bundled.
    assert.ok(doctor.dependencies.find(item => item.command === 'node')?.available, JSON.stringify(doctor.dependencies));
    // Exercise the same prerequisite checks as init without requiring an account or an agent.
    const checks = JSON.parse(checked(path.join(release, 'runtime/bin/node'), ['--input-type=module', '-e', `
      import { generationChecks } from ${JSON.stringify(pathToFileURL(path.join(release, 'mcp/scripts/lib/cli.mjs')).href)};
      process.env.PATH = ${JSON.stringify(path.join(release, 'runtime/bin'))} + ':' + process.env.PATH;
      console.log(JSON.stringify(await generationChecks(${JSON.stringify(path.join(release, 'mcp/engine'))})));
    `], { env }));
    // The bundled engine must be present; Chromium is downloaded later, at setup.
    assert.ok(checks.find(item => item.name === 'article skills')?.available, JSON.stringify(checks));
  };
  assert.equal(checked(cli, ['--version'], { env }).trim(), '0.0.0');
  checkTools();
  assert.match(checked(cli, ['--help'], { env }), /update/);
  const config = path.join(home, 'saved-configuration');
  await writeFile(config, 'keep credentials and project links');
  const registration = { command: path.join(data, 'current/runtime/bin/node'), args: [path.join(data, 'current/mcp/dist/index.js'), '--help'] };
  env.SMOKE_LATEST = version;
  assert.match(checked(cli, ['update'], { env }), /Restart running coding-agent sessions/);
  assert.equal(checked(cli, ['--version'], { env }).trim(), version);
  checkTools();
  checked(registration.command, registration.args, { env });
  assert.equal(await readFile(config, 'utf8'), 'keep credentials and project links');
  assert.match(checked(cli, ['update'], { env }), /No update needed/);
  env.SMOKE_LATEST = '0.0.0';
  assert.match(checked(cli, ['update'], { env }), /No update needed/);
  assert.equal(checked(cli, ['--version'], { env }).trim(), version);
  process.stdout.write(`Install, update, stable MCP paths and repeat updates passed for ${process.platform}/${process.arch}.\n`);
} finally { await rm(temporary, { recursive: true, force: true }); }
