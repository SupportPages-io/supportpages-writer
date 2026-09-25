import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { installClaudeWriter } from '../scripts/lib/claude-writer.mjs';
import { writerAgentFile, writerAgentType } from '../dist/writer-agent.js';

async function fixture(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'supportpages-writer-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return { home, env: {} };
}

test('personal writer is discoverable without CLI launch flags and repeat installation is unchanged', async t => {
  const options = await fixture(t);
  const first = await installClaudeWriter(options);
  assert.equal(first.filename, path.join(options.home, '.claude/agents/supportpages-io.md'));
  assert.equal(first.changed, true);
  const definition = await readFile(first.filename, 'utf8');
  assert.match(definition, /^---\nname: supportpages-io\n/);
  assert.match(definition, /\nmodel: inherit\n/);
  assert.doesNotMatch(definition, /\n(?:permissionMode|isolation):/);
  assert.equal(definition, writerAgentFile);
  assert.deepEqual(await installClaudeWriter(options), { filename: first.filename, changed: false });
});

test('updating a managed writer keeps a backup outside agent discovery', async t => {
  const options = await fixture(t);
  const { filename } = await installClaudeWriter(options);
  const older = writerAgentFile + '\nOlder managed definition\n';
  await writeFile(filename, older);
  assert.equal((await installClaudeWriter(options)).changed, true);
  const backups = (await readdir(path.dirname(filename))).filter(name => name.includes('.backup-'));
  assert.equal(backups.length, 1);
  assert.ok(!backups[0].endsWith('.md'));
  assert.equal(await readFile(path.join(path.dirname(filename), backups[0]), 'utf8'), older);
});

test('custom agents, including empty files, are preserved', async t => {
  const options = await fixture(t);
  const directory = path.join(options.home, '.claude/agents');
  await mkdir(directory, { recursive: true });
  const filename = path.join(directory, `${writerAgentType}.md`);
  for (const custom of ['My own writer', '']) {
    await writeFile(filename, custom);
    await assert.rejects(installClaudeWriter(options), /custom agent already exists/);
    assert.equal(await readFile(filename, 'utf8'), custom);
  }
});

test('custom Claude configuration directories are respected', async t => {
  const options = await fixture(t);
  options.env.CLAUDE_CONFIG_DIR = path.join(options.home, 'alternate');
  const result = await installClaudeWriter(options);
  assert.equal(result.filename, path.join(options.env.CLAUDE_CONFIG_DIR, 'agents/supportpages-io.md'));
  await assert.rejects(readFile(path.join(options.home, '.claude/agents/supportpages-io.md')), { code: 'ENOENT' });
});

test('symlinked agent files cannot overwrite another file', async t => {
  const options = await fixture(t);
  const directory = path.join(options.home, '.claude/agents');
  await mkdir(directory, { recursive: true });
  const target = path.join(options.home, 'other.md');
  await writeFile(target, 'Keep me');
  await symlink(target, path.join(directory, `${writerAgentType}.md`));
  await assert.rejects(installClaudeWriter(options), /unsafe path/);
  assert.equal(await readFile(target, 'utf8'), 'Keep me');
});
