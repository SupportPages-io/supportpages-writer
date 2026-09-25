#!/usr/bin/env node
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { parseArgs, promisify } from 'node:util';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkRelease, releaseVersionPattern, repositoryRoot } from './check-release.mjs';

// Keep publishing independent of the built CLI and its npm dependencies.
const execute = promisify(execFile);
const runAws = async (args, env) => (await execute('aws', args, { env, maxBuffer: 1024 * 1024 })).stdout;

function newerThan(version, previous) {
  if (!releaseVersionPattern.test(previous)) throw Error('The remote latest.txt is not a valid release version.');
  const a = version.split('.').map(BigInt), b = previous.split('.').map(BigInt);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

export async function publishRelease({ directory = 'release', root = repositoryRoot, dryRun = false, env = process.env, run = runAws } = {}) {
  directory = path.resolve(directory);
  const version = await checkRelease({ root, env });
  const archives = [];
  // Validate every platform before making any remote changes.
  for (const platform of ['darwin', 'linux']) for (const arch of ['arm64', 'x64']) {
    const name = `supportpages-${version}-${platform}-${arch}.tar.gz`;
    const sha256 = createHash('sha256').update(await readFile(path.join(directory, name))).digest('hex');
    if ((await readFile(path.join(directory, name + '.sha256'), 'utf8')).trim() !== `${sha256}  ${name}`) {
      throw Error(`Release checksum mismatch: ${name}`);
    }
    archives.push({ platform, arch, name, sha256 });
  }
  const manifest = { version, archives };
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(path.join(directory, 'latest.txt'), version + '\n');
  await copyFile(path.join(root, 'install-cli.sh'), path.join(directory, 'install.sh'));
  if (dryRun) return manifest;

  const bucket = env.CLI_RELEASE_BUCKET;
  if (!bucket || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw Error('Set CLI_RELEASE_BUCKET to the dedicated R2 download bucket.');
  }
  // Accept Cloudflare's default and jurisdiction-specific S3 endpoints only.
  const endpoint = env.CLI_RELEASE_R2_ENDPOINT;
  if (!/^https:\/\/[a-f0-9]{32}(?:\.(?:eu|fedramp|us))?\.r2\.cloudflarestorage\.com\/?$/.test(endpoint ?? '')) {
    throw Error('Set CLI_RELEASE_R2_ENDPOINT to the HTTPS S3 API endpoint shown in the R2 bucket settings.');
  }
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) {
    throw Error('Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY to the R2 access key pair.');
  }
  const awsEnv = { ...env, AWS_DEFAULT_REGION: 'auto', AWS_REGION: 'auto', AWS_EC2_METADATA_DISABLED: 'true', AWS_PAGER: '',
    AWS_REQUEST_CHECKSUM_CALCULATION: 'when_required', AWS_RESPONSE_CHECKSUM_VALIDATION: 'when_required' };
  delete awsEnv.AWS_SESSION_TOKEN;
  delete awsEnv.AWS_PROFILE;
  const aws = args => run(['--endpoint-url', endpoint, '--region', 'auto', ...args], awsEnv);
  const contents = async (prefix, maxKeys) => {
    const result = JSON.parse(await aws(['s3api', 'list-objects-v2', '--bucket', bucket, '--prefix', prefix, '--max-keys', String(maxKeys), '--no-paginate', '--output', 'json']));
    if (!result || typeof result !== 'object' || (result.Contents !== undefined && !Array.isArray(result.Contents))) {
      throw Error('Could not check the R2 bucket contents.');
    }
    return result.Contents ?? [];
  };
  if ((await contents(`${version}/`, 1)).length) throw Error('Cannot publish over an existing release. Use a new version.');
  if ((await contents('latest.txt', 1)).some(object => object.Key === 'latest.txt')) {
    const previous = (await aws(['s3', 'cp', `s3://${bucket}/latest.txt`, '-', '--only-show-errors'])).trim();
    if (!newerThan(version, previous)) throw Error(`Cannot promote ${version}: latest is already ${previous}.`);
  }
  const upload = async (name, key, cacheControl) => {
    const contentType = name.endsWith('.tar.gz') ? 'application/gzip' : name.endsWith('.json') ? 'application/json' : 'text/plain';
    await aws(['s3', 'cp', path.join(directory, name), `s3://${bucket}/${key}`, '--cache-control', cacheControl, '--content-type', contentType, '--only-show-errors']);
  };
  for (const name of [...archives.flatMap(archive => [archive.name, archive.name + '.sha256']), 'manifest.json', 'install.sh']) {
    await upload(name, `${version}/${name}`, 'public,max-age=31536000,immutable');
  }
  // Mutable entry points are promoted only after every versioned upload succeeds.
  await upload('install.sh', 'install.sh', 'no-cache');
  await upload('latest.txt', 'latest.txt', 'no-cache');
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const { values } = parseArgs({ options: { directory: { type: 'string' }, 'dry-run': { type: 'boolean' } } });
  try {
    const manifest = await publishRelease({ directory: values.directory, dryRun: values['dry-run'] });
    process.stdout.write(values['dry-run'] ? JSON.stringify(manifest, null, 2) + '\n' : `Published SupportPages.io ${manifest.version} to R2.\n`);
  } catch (error) {
    process.stderr.write(`Release failed: ${error.message}\nlatest.txt is promoted only after all other uploads succeed.\n`);
    process.exitCode = 1;
  }
}
