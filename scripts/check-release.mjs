#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const releaseVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export async function checkRelease({ root = repositoryRoot, env = process.env } = {}) {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
  if (!releaseVersionPattern.test(pkg.version) || lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version) {
    throw Error('package.json and package-lock.json must have the same X.Y.Z release version.');
  }
  // The engine's renderer runs on the package's puppeteer, so the two pins must agree.
  const engine = JSON.parse(await readFile(path.join(root, 'engine', 'generate-illustrated-article', 'package.json'), 'utf8'));
  if (engine.dependencies?.puppeteer !== pkg.dependencies?.puppeteer) {
    throw Error(`package.json must pin puppeteer ${engine.dependencies?.puppeteer} to match engine/generate-illustrated-article.`);
  }
  // MCP Registry metadata names the same package version.
  let server;
  try { server = JSON.parse(await readFile(path.join(root, 'server.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (server && (server.version !== pkg.version || server.packages?.some(entry => entry.version !== pkg.version))) {
    throw Error(`server.json must use version ${pkg.version} for the server and its packages.`);
  }
  const tagged = env.GITHUB_REF_TYPE === 'tag';
  if (tagged && env.GITHUB_REF_NAME !== `v${pkg.version}`) {
    throw Error(`Release tag must be v${pkg.version}, matching package.json.`);
  }
  if (env.CLI_RELEASE_PUBLISH === 'true' && !tagged) {
    throw Error('Publishing requires a vX.Y.Z tag. Run a build-only workflow on branches.');
  }
  return pkg.version;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.stdout.write(`${await checkRelease()}\n`);
}
