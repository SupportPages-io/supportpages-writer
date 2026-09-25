import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { checkRelease } from '../scripts/check-release.mjs';
import { publishRelease } from '../scripts/publish-release.mjs';

async function fixture(t, { previous, existing = false, failKey } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'supportpages-release-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'release');
  await mkdir(directory);
  const version = '0.10.0';
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ version, dependencies: { puppeteer: '25.11.0' } }));
  await mkdir(path.join(root, 'engine', 'generate-illustrated-article'), { recursive: true });
  await writeFile(path.join(root, 'engine', 'generate-illustrated-article', 'package.json'), JSON.stringify({ dependencies: { puppeteer: '25.11.0' } }));
  await writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ version, packages: { '': { version } } }));
  await writeFile(path.join(root, 'install-cli.sh'), '#!/bin/bash\necho installer\n');
  const names = [];
  for (const platform of ['darwin', 'linux']) for (const arch of ['arm64', 'x64']) {
    const name = `supportpages-${version}-${platform}-${arch}.tar.gz`, data = `${platform}/${arch}`;
    await writeFile(path.join(directory, name), data);
    await writeFile(path.join(directory, name + '.sha256'), `${createHash('sha256').update(data).digest('hex')}  ${name}\n`);
    names.push(name);
  }
  const env = {
    CLI_RELEASE_BUCKET: 'supportpages-cli-releases',
    CLI_RELEASE_R2_ENDPOINT: `https://${'a'.repeat(32)}.r2.cloudflarestorage.com`,
    AWS_ACCESS_KEY_ID: 'test-key', AWS_SECRET_ACCESS_KEY: 'test-secret',
    AWS_SESSION_TOKEN: 'unrelated-session', AWS_PROFILE: 'unrelated-profile',
    GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: `v${version}`, CLI_RELEASE_PUBLISH: 'true',
  };
  const calls = [], uploads = [];
  const run = async (args, awsEnv) => {
    calls.push(args);
    assert.equal(args[1], env.CLI_RELEASE_R2_ENDPOINT);
    assert.equal(awsEnv.AWS_REGION, 'auto');
    assert.equal(awsEnv.AWS_SESSION_TOKEN, undefined);
    assert.equal(awsEnv.AWS_PROFILE, undefined);
    if (args.includes('list-objects-v2')) {
      const prefix = args[args.indexOf('--prefix') + 1];
      return JSON.stringify({ Contents: prefix === 'latest.txt' ? (previous === undefined ? [] : [{ Key: 'latest.txt' }]) : (existing ? [{ Key: `${version}/manifest.json` }] : []) });
    }
    const index = args.indexOf('cp'), source = args[index + 1], target = args[index + 2];
    if (target === '-') return previous + '\n';
    const key = target.slice(`s3://${env.CLI_RELEASE_BUCKET}/`.length);
    if (key === failKey) throw Error('Simulated upload failure');
    uploads.push({ key, data: await readFile(source, 'utf8'), cache: args[args.indexOf('--cache-control') + 1] });
    return '';
  };
  return { root, directory, version, names, env, run, calls, uploads };
}

test('publishes all platforms and installer before promoting latest to R2', async t => {
  const f = await fixture(t, { previous: '0.9.0' });
  assert.equal((await publishRelease(f)).archives.length, 4);
  assert.equal(f.uploads.length, 12);
  assert.deepEqual(f.uploads.slice(-2).map(x => [x.key, x.cache]), [['install.sh', 'no-cache'], ['latest.txt', 'no-cache']]);
  assert.ok(f.uploads.slice(0, -2).every(x => x.key.startsWith('0.10.0/') && x.cache.includes('immutable')));
  assert.equal(f.uploads.at(-1).data, '0.10.0\n');
  assert.equal(f.uploads.at(-2).data, await readFile(path.join(f.root, 'install-cli.sh'), 'utf8'));
});

test('first release works with an empty bucket', async t => {
  const f = await fixture(t);
  await publishRelease(f);
  assert.equal(f.uploads.at(-1).key, 'latest.txt');
});

test('checksum failure or missing platform never touches R2', async t => {
  for (const missing of [true, false]) {
    const f = await fixture(t);
    if (missing) await rm(path.join(f.directory, f.names.at(-1)));
    else await writeFile(path.join(f.directory, f.names.at(-1)), 'corrupted');
    await assert.rejects(publishRelease(f));
    assert.equal(f.calls.length, 0);
  }
});

test('existing versions, older versions and invalid latest pointers never upload', async t => {
  for (const options of [{ existing: true }, { previous: '1.0.0' }, { previous: '0.10.0' }, { previous: 'invalid' }]) {
    const f = await fixture(t, options);
    await assert.rejects(publishRelease(f), /existing release|Cannot promote|not a valid release/);
    assert.equal(f.uploads.length, 0);
  }
});

test('failed bucket checks never upload', async t => {
  const f = await fixture(t);
  await assert.rejects(publishRelease({ ...f, run: async () => { throw Error('Access denied'); } }), /Access denied/);
  assert.equal(f.uploads.length, 0);
});

test('failed versioned or installer uploads never promote latest', async t => {
  for (const failKey of ['0.10.0/manifest.json', 'install.sh']) {
    const f = await fixture(t, { failKey });
    await assert.rejects(publishRelease(f), /Simulated upload failure/);
    assert.ok(!f.uploads.some(x => x.key === 'latest.txt'));
    if (failKey.startsWith('0.10.0/')) assert.ok(!f.uploads.some(x => x.key === 'install.sh'));
  }
});

test('R2 configuration must be explicit and cannot point credentials at another host', async t => {
  for (const override of [
    { CLI_RELEASE_BUCKET: '' }, { CLI_RELEASE_R2_ENDPOINT: '' },
    { CLI_RELEASE_R2_ENDPOINT: 'https://example.com' },
    { CLI_RELEASE_R2_ENDPOINT: `https://${'a'.repeat(32)}.r2.cloudflarestorage.com.evil.example` },
    { AWS_SECRET_ACCESS_KEY: '' },
  ]) {
    const f = await fixture(t);
    Object.assign(f.env, override);
    await assert.rejects(publishRelease(f), /Set /);
    assert.equal(f.calls.length, 0);
  }
});

test('jurisdiction-specific R2 endpoints are supported', async t => {
  const f = await fixture(t);
  f.env.CLI_RELEASE_R2_ENDPOINT = `https://${'a'.repeat(32)}.eu.r2.cloudflarestorage.com`;
  await publishRelease(f);
  assert.equal(f.uploads.at(-1).key, 'latest.txt');
});

test('dry run needs no credentials, AWS CLI, built dist or npm dependencies', async t => {
  const f = await fixture(t);
  const scripts = path.join(f.root, 'scripts');
  await mkdir(scripts);
  for (const name of ['publish-release.mjs', 'check-release.mjs']) await copyFile(new URL(`../scripts/${name}`, import.meta.url), path.join(scripts, name));
  const result = spawnSync(process.execPath, [path.join(scripts, 'publish-release.mjs'), '--directory', f.directory, '--dry-run'], {
    encoding: 'utf8', env: { PATH: '' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).archives.length, 4);
  assert.equal(await readFile(path.join(f.directory, 'latest.txt'), 'utf8'), '0.10.0\n');
});

test('tag, package and lock versions must match, and branch publishing is rejected', async t => {
  const f = await fixture(t);
  assert.equal(await checkRelease(f), '0.10.0');
  await assert.rejects(checkRelease({ ...f, env: { ...f.env, GITHUB_REF_NAME: 'v0.9.0' } }), /tag must be/);
  await assert.rejects(checkRelease({ ...f, env: { ...f.env, GITHUB_REF_TYPE: 'branch' } }), /Publishing requires/);
  assert.equal(await checkRelease({ ...f, env: {} }), '0.10.0');
  await writeFile(path.join(f.root, 'engine', 'generate-illustrated-article', 'package.json'), JSON.stringify({ dependencies: { puppeteer: '26.0.0' } }));
  await assert.rejects(checkRelease({ ...f, env: {} }), /must pin puppeteer 26\.0\.0/);
  await writeFile(path.join(f.root, 'engine', 'generate-illustrated-article', 'package.json'), JSON.stringify({ dependencies: { puppeteer: '25.11.0' } }));
  await writeFile(path.join(f.root, 'server.json'), JSON.stringify({ version: '0.10.0', packages: [{ version: '0.9.0' }] }));
  await assert.rejects(checkRelease({ ...f, env: {} }), /server\.json must use version 0\.10\.0/);
  await writeFile(path.join(f.root, 'package-lock.json'), JSON.stringify({ version: '0.9.0' }));
  await assert.rejects(checkRelease(f), /same X.Y.Z/);
});
