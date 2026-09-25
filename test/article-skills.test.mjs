import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, lstat, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { retirePublicSkillLinks, installArticleSkills } from '../scripts/lib/article-skills.mjs';
import { command } from '../scripts/lib/install.mjs';

test('Claude trace hooks run the engine hook with the installation node and replace older trace hooks', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "supportpages hook ' "));
  t.after(() => rm(home, { recursive: true, force: true }));
  const directory = path.join(home, 'engine');
  const script = path.join(directory, 'generate-illustrated-article/scripts/trace_hook.js');
  await mkdir(path.dirname(script), { recursive: true });
  await writeFile(script, "process.stdout.write('hook ran\\n');\n");
  await mkdir(path.join(home, '.claude'));
  await writeFile(path.join(home, '.claude/settings.json'), JSON.stringify({ hooks: { PostToolUse: [
    { matcher: '*', hooks: [{ type: 'command', command: "'/old/.rtfm-skills/generate-illustrated-article/scripts/trace_hook.sh'" }] },
    { matcher: 'Bash', hooks: [{ type: 'command', command: 'other-hook' }] },
  ] } }));
  let settings;
  await installArticleSkills({ home, client: 'claude', directory, hookCommand: [process.execPath, script], writeJson: async (_file, data) => { settings = data; } });
  assert.deepEqual(settings.hooks.PostToolUse.map(group => group.matcher), ['Bash', '*']);
  const hook = settings.hooks.PostToolUse[1].hooks[0].command;
  // Hooks run outside the CLI environment: the command must not depend on PATH.
  const result = await command('/bin/sh', ['-c', hook], { capture: true, env: { PATH: '' } });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, 'hook ran\n');
});

test('migration follows owned chained links and previous roots while preserving independent skills', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'supportpages-skill-migration-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const directory = path.join(home, 'engines/new'), previousDirectory = path.join(home, 'engines/old');
  await mkdir(path.join(previousDirectory, 'generate-illustrated-article'), { recursive: true });
  await mkdir(directory, { recursive: true });
  await symlink(previousDirectory, path.join(home, '.rtfm-skills'));
  const env = { CLAUDE_CONFIG_DIR: path.join(home, 'custom-claude'), CODEX_HOME: path.join(home, 'custom-codex') };
  const paths = ['.agents/skills', '.claude/skills', '.codex/skills', 'custom-claude/skills', 'custom-codex/skills'];
  for (const relative of paths) await mkdir(path.join(home, relative), { recursive: true });
  const shared = path.join(home, '.agents/skills/generate-illustrated-article');
  await symlink('../../.rtfm-skills/generate-illustrated-article', shared);
  const owned = [shared];
  for (const relative of paths.slice(1)) {
    const filename = path.join(home, relative, 'generate-illustrated-article');
    await symlink(shared, filename);
    owned.push(filename);
  }
  // Old releases may already have been removed; their owned dangling links still retire.
  const dangling = path.join(home, '.agents/skills/suggest-sections');
  await symlink(path.join(previousDirectory, 'suggest-sections'), dangling);
  owned.push(dangling);
  const independent = path.join(home, '.agents/skills/detect-project');
  await symlink('/independently-installed/detect-project', independent);
  const folder = path.join(home, '.claude/skills/detect-project');
  await mkdir(folder);
  const options = { home, clients: ['claude', 'codex'], directory, previousDirectory, env };
  assert.deepEqual((await retirePublicSkillLinks(options)).sort(), owned.sort());
  for (const filename of owned) await assert.rejects(lstat(filename), { code: 'ENOENT' });
  assert.ok((await lstat(independent)).isSymbolicLink());
  assert.ok((await lstat(folder)).isDirectory());
  assert.ok((await lstat(path.join(previousDirectory, 'generate-illustrated-article'))).isDirectory());
  assert.deepEqual(await retirePublicSkillLinks(options), []);
});

test('legacy installs identify old skill links through the engine anchor when MCP moved to a worktree', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'supportpages-skill-worktree-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const old = path.join(home, 'engines'), directory = path.join(old, '.claude/worktrees/article-polish');
  await mkdir(path.join(old, 'generate-illustrated-article'), { recursive: true });
  await mkdir(directory, { recursive: true });
  await symlink(old, path.join(home, '.rtfm-skills'));
  await mkdir(path.join(home, '.claude/skills'), { recursive: true });
  const filename = path.join(home, '.claude/skills/generate-illustrated-article');
  await symlink(path.join(old, 'generate-illustrated-article'), filename);
  assert.deepEqual(await retirePublicSkillLinks({ home, clients: ['claude'], directory }), [filename]);
  await assert.rejects(lstat(filename), { code: 'ENOENT' });
  assert.ok((await lstat(path.join(old, 'generate-illustrated-article'))).isDirectory());
});
