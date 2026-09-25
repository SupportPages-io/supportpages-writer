import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile, symlink } from 'node:fs/promises';
import { fixture } from './helpers.mjs';
import { findSkills, installationSkills } from '../scripts/lib/install.mjs';
import { generationChecks } from '../scripts/lib/cli.mjs';

async function engineAt(directory) {
  for (const skill of ['detect-project', 'generate-illustrated-article']) {
    await mkdir(path.join(directory, skill), { recursive: true });
    await writeFile(path.join(directory, skill, 'SKILL.md'), 'fixture');
  }
}

test('installer maps old managed skills and engine paths to its own engine, preserving external checkouts', async t => {
  const f = await fixture(t);
  const home = path.join(f.root, 'home');
  const cli = path.join(home, '.local/share/supportpages/cli');
  const previousSkills = path.join(cli, 'versions/old/mcp/skills');
  const previousEngine = path.join(cli, 'versions/older/mcp/engine');
  const installRoot = path.join(cli, 'versions/new/mcp');
  const current = path.join(installRoot, 'engine');
  const external = path.join(f.root, 'external');
  for (const dir of [previousSkills, previousEngine, current, external]) await engineAt(dir);
  const options = { home, installRoot };
  assert.equal((await findSkills(previousSkills, options)).directory, current);
  assert.equal((await findSkills(previousEngine, options)).directory, current);
  assert.equal((await findSkills(undefined, options)).directory, current);
  assert.equal((await findSkills(external, options)).directory, external);
  assert.equal(await installationSkills(installRoot, previousSkills), current);
  // Skills copies earlier setups kept in the shared data directory are managed too.
  const sharedCopy = path.join(home, '.local/share/supportpages/skills/local-renderer-191d66c');
  await engineAt(sharedCopy);
  assert.equal((await findSkills(sharedCopy, options)).directory, current);
});

test('updates prepare Chromium for a renderer that an older release used through the managed shortcut', async t => {
  const f = await fixture(t);
  const home = path.join(f.root, 'home');
  const cli = path.join(home, '.local/share/supportpages/cli');
  const previous = path.join(cli, 'versions/local/mcp');
  const next = path.join(cli, 'versions/new/mcp');
  const legacy = path.join(cli, 'versions/old/mcp/skills');
  await mkdir(path.join(legacy, 'generate-illustrated-article/node_modules'), { recursive: true });
  await symlink(legacy, path.join(home, '.rtfm-skills'));
  await engineAt(path.join(next, 'engine'));
  const calls = [];
  const { prepareUpdate } = await import('../scripts/lib/prepare-update.mjs');
  await prepareUpdate(previous, next, { home, env: {}, run: async (...args) => { calls.push(args); return { code: 0 }; } });
  assert.equal(calls.length, 1, 'the renderer check passed, so nothing was downloaded');
  assert.equal(calls[0][0], path.resolve(next, '../runtime/bin/node'));
  assert.ok(calls[0][1].some(arg => String(arg).includes('executablePath')));
});

test('renderer readiness supports async executablePath in Puppeteer 25 and synchronous older versions', async t => {
  const f = await fixture(t);
  const skill = path.join(f.root, 'skills/generate-illustrated-article');
  const module = path.join(skill, 'node_modules/puppeteer');
  await mkdir(module, { recursive: true });
  await writeFile(path.join(skill, 'package.json'), '{}');
  const browser = path.join(skill, 'browser');
  await writeFile(browser, 'test browser');
  for (const asyncPrefix of ['', 'async ']) {
    await writeFile(path.join(module, 'index.js'), `exports.executablePath = ${asyncPrefix}() => ${JSON.stringify(browser)};`);
    const checks = await generationChecks(path.dirname(skill));
    assert.equal(checks.find(check => check.name === 'article renderer and Chromium').available, true);
  }
  await writeFile(path.join(module, 'index.js'), `exports.executablePath = async () => ${JSON.stringify(browser + '-missing')};`);
  const checks = await generationChecks(path.dirname(skill));
  assert.equal(checks.find(check => check.name === 'article renderer and Chromium').available, false);
});
