#!/usr/bin/env node
// Assemble the installable plugin tree that the `plugin` branch publishes.
//
// Claude Code and Codex install plugins by copying a git checkout. Neither
// builds TypeScript, and Codex installs no npm dependencies, so the tree ships
// compiled dist/ and production node_modules. Chromium is not included: the
// plugin's SessionStart hook downloads it on first use.
//
// Usage: node scripts/build-plugin.mjs --out <directory> [--skip-install]
//   --skip-install  leave out node_modules (tests)
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { command, exists } from './lib/install.mjs';

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_FILES = ['dist', 'engine', 'scripts', 'package.json', 'package-lock.json', 'LICENSE', 'NOTICE', 'README.md'];

export async function buildPlugin({ out, root = repositoryRoot, install = true, run = command } = {}) {
  if (!await exists(path.join(root, 'dist/writer-agent.js'))) throw Error('Build the server first: npm run build.');
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  out = path.resolve(out);
  await mkdir(out, { recursive: true });
  // Replace everything except the branch's own git metadata.
  for (const name of await readdir(out)) if (name !== '.git') await rm(path.join(out, name), { recursive: true, force: true });

  await cp(path.join(root, 'plugin'), out, { recursive: true });
  const manifest = path.join(out, '.claude-plugin/plugin.json');
  const plugin = JSON.parse(await readFile(manifest, 'utf8'));
  await writeFile(manifest, JSON.stringify({ ...plugin, version: pkg.version }, null, 2) + '\n');

  // The writer subagent, from the same definition the CLI installs.
  const { writerAgentFile, writerAgentType } = await import(pathToFileURL(path.join(root, 'dist/writer-agent.js')).href);
  await mkdir(path.join(out, 'agents'), { recursive: true });
  await writeFile(path.join(out, 'agents', `${writerAgentType}.md`), writerAgentFile);

  for (const name of PACKAGE_FILES) await cp(path.join(root, name), path.join(out, name), { recursive: true });

  if (install) {
    // --ignore-scripts skips puppeteer's Chromium download, as plugin installs do.
    const result = await run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: out });
    if (result.code) throw Error('npm ci failed while building the plugin.');
  }
  return { out, version: pkg.version };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: { out: { type: 'string' }, 'skip-install': { type: 'boolean' } } });
    if (!values.out) throw Error('Usage: build-plugin.mjs --out <directory> [--skip-install]');
    const result = await buildPlugin({ out: values.out, install: !values['skip-install'] });
    process.stdout.write(`${result.out} (${result.version})\n`);
  } catch (error) {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  }
}
