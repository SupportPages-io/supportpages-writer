import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { installCodexSkill, refreshCodexSkill } from '../scripts/lib/codex-skill.mjs';
import { prepareUpdate } from '../scripts/lib/prepare-update.mjs';
import { installManagedWriter } from '../scripts/lib/managed-writer.mjs';
import { codexWriterFile, writerAgentFile } from '../dist/writer-agent.js';

async function fixture(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'supportpages-skill-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const config = path.join(home, 'custom-codex');
  const options = { home, env: { CODEX_HOME: config } };
  const filename = path.join(config, 'skills/supportpages/SKILL.md');
  return { home, config, options, filename };
}

test('skill installation upgrades owned instructions with backup and is idempotent', async t => {
  const f = await fixture(t);
  const initial = await installCodexSkill(f.options);
  assert.equal(initial.filename, f.filename); assert.equal(initial.changed, true);
  const contents = await readFile(f.filename, 'utf8');
  const old = contents + '\nPrevious managed version\n';
  await writeFile(f.filename, old);
  assert.equal((await installCodexSkill(f.options)).changed, true);
  const files = await readdir(path.dirname(f.filename));
  const backups = files.filter(name => name.startsWith('SKILL.md.backup-'));
  assert.equal(backups.length, 1);
  assert.equal(await readFile(path.join(path.dirname(f.filename), backups[0]), 'utf8'), old);
  assert.equal(await readFile(f.filename, 'utf8'), contents);
  assert.equal((await installCodexSkill(f.options)).changed, false);
  assert.deepEqual(await readdir(path.dirname(f.filename)), files);
});

test('skill setup preserves custom files and rejects symlinks at every installed path', async t => {
  const f = await fixture(t);
  await mkdir(path.dirname(f.filename), { recursive: true });
  await writeFile(f.filename, 'User instructions');
  await assert.rejects(installCodexSkill(f.options), /custom skill already exists/);
  assert.equal(await readFile(f.filename, 'utf8'), 'User instructions');
  for (const parts of [[], ['skills'], ['skills', 'supportpages'], ['skills', 'supportpages', 'SKILL.md']]) {
    const g = await fixture(t);
    const entry = path.join(g.config, ...parts), target = path.join(g.home, 'target');
    await mkdir(path.dirname(entry), { recursive: true });
    if (parts.length === 3) await writeFile(target, 'Untouched'); else await mkdir(target);
    await symlink(target, entry);
    await assert.rejects(installCodexSkill(g.options), /unsafe path/);
    if (parts.length === 3) assert.equal(await readFile(target, 'utf8'), 'Untouched');
    else assert.deepEqual(await readdir(target), []);
  }
});

test('release preparation adds the skill only to an existing managed Codex integration', async t => {
  const f = await fixture(t);
  const previous = path.join(f.home, 'previous'), next = path.join(f.home, 'next');
  await prepareUpdate(previous, next, f.options);
  await assert.rejects(readFile(f.filename), { code: 'ENOENT' });
  const writer = path.join(f.config, 'agents/supportpages-io.toml');
  await mkdir(path.dirname(writer), { recursive: true });
  await writeFile(writer, 'name = "custom"');
  await prepareUpdate(previous, next, f.options);
  await assert.rejects(readFile(f.filename), { code: 'ENOENT' });
  await writeFile(writer, codexWriterFile);
  await prepareUpdate(previous, next, f.options);
  const contents = await readFile(f.filename, 'utf8');
  assert.equal(await readFile(writer, 'utf8'), codexWriterFile);
  await writeFile(f.filename, contents + '\nPrevious version');
  await prepareUpdate(previous, next, f.options);
  assert.equal(await readFile(f.filename, 'utf8'), contents);
  await writeFile(f.filename, 'My custom skill');
  await assert.rejects(prepareUpdate(previous, next, f.options), /custom skill already exists/);
  assert.equal(await readFile(f.filename, 'utf8'), 'My custom skill');
});

test('failed renderer preparation does not refresh installed skill instructions', async t => {
  const f = await fixture(t);
  await installManagedWriter({ config: f.config, name: 'supportpages-io', extension: 'toml', contents: codexWriterFile, marker: '# Managed by SupportPages: article writer v1' });
  const previous = path.join(f.home, 'previous'), next = path.join(f.home, 'next');
  await mkdir(path.join(previous, 'skills/generate-illustrated-article/node_modules'), { recursive: true });
  const renderer = path.join(next, 'engine/generate-illustrated-article');
  await mkdir(renderer, { recursive: true });
  await writeFile(path.join(renderer, 'SKILL.md'), 'fixture');
  await assert.rejects(prepareUpdate(previous, next, { ...f.options, run: async () => ({ code: 1, stdout: '' }) }), /current release is still active/);
  await assert.rejects(readFile(f.filename), { code: 'ENOENT' });
});

test('upgrades replace old quiet writer policies for both clients and preserve permission settings', async t => {
  const f = await fixture(t);
  const claude = path.join(f.home, 'custom-claude');
  const options = { ...f.options, env: { ...f.options.env, CLAUDE_CONFIG_DIR: claude } };
  const codexFile = path.join(f.config, 'agents/supportpages-io.toml');
  const claudeFile = path.join(claude, 'agents/supportpages-io.md');
  await mkdir(path.dirname(codexFile), { recursive: true });
  await mkdir(path.dirname(claudeFile), { recursive: true });
  await writeFile(codexFile, '# Managed by SupportPages: article writer v1\nold quiet instructions\n');
  await writeFile(claudeFile, '<!-- Managed by SupportPages: article writer v1 -->\nold quiet instructions\n');
  const permissions = 'sandbox_mode = "workspace-write"\napproval_policy = "on-request"\n';
  await writeFile(path.join(f.config, 'config.toml'), permissions);
  await prepareUpdate(path.join(f.home, 'previous'), path.join(f.home, 'next'), options);
  assert.equal(await readFile(codexFile, 'utf8'), codexWriterFile);
  assert.equal(await readFile(claudeFile, 'utf8'), writerAgentFile);
  assert.equal(await readFile(path.join(f.config, 'config.toml'), 'utf8'), permissions);
  for (const file of [codexFile, claudeFile]) assert.ok((await readdir(path.dirname(file))).some(name => name.startsWith(path.basename(file) + '.backup-')));
  await writeFile(claudeFile, 'Custom writer');
  await prepareUpdate(path.join(f.home, 'previous'), path.join(f.home, 'next'), options);
  assert.equal(await readFile(claudeFile, 'utf8'), 'Custom writer');
});

test('upgrade detects symlinked existing agent instructions without following them', async t => {
  const f = await fixture(t);
  const target = path.join(f.home, 'target');
  await mkdir(target); await writeFile(path.join(target, 'supportpages-io.toml'), codexWriterFile);
  await mkdir(f.config); await symlink(target, path.join(f.config, 'agents'));
  await assert.rejects(refreshCodexSkill(f.options), /unsafe path/);
  await assert.rejects(readFile(f.filename), { code: 'ENOENT' });
});
