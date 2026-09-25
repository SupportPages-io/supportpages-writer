import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { installClaudePermissions } from '../scripts/lib/claude-permissions.mjs';
import { backup, privateJson } from '../scripts/lib/install.mjs';

async function fixture(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'supportpages-permissions-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return { home, env: {}, name: 'supportpages', configDir: path.join(home, '.config/supportpages'), backup, writeJson: privateJson };
}

const rulesFor = name => ({ allow: [`mcp__${name}`],
  ask: [`mcp__${name}__supportpages_delete_article`, `mcp__${name}__supportpages_unpublish_article`] });

test('every tool on the connection is allowed and removals ask, per connection name, idempotently', async t => {
  const options = await fixture(t);
  for (const name of ['supportpages', 'supportpages-dev', 'supportpages-custom']) {
    const result = await installClaudePermissions({ ...options, name });
    assert.deepEqual(result.rules, rulesFor(name));
    assert.equal(result.changed, true);
    assert.equal((await installClaudePermissions({ ...options, name })).changed, false);
  }
  const settings = JSON.parse(await readFile(path.join(options.home, '.claude/settings.json'), 'utf8'));
  const names = ['supportpages', 'supportpages-dev', 'supportpages-custom'];
  assert.deepEqual(settings, { permissions: { allow: names.flatMap(name => rulesFor(name).allow), ask: names.flatMap(name => rulesFor(name).ask) } });
});

test('permission installation preserves hooks, modes, existing rules and a backup', async t => {
  const options = await fixture(t);
  const filename = path.join(options.home, '.claude/settings.json');
  const original = { model: 'opus', hooks: { PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'trace-hook' }] }] },
    permissions: { defaultMode: 'auto', allow: ['Read'], ask: ['mcp__supportpages__*'], deny: ['mcp__supportpages__supportpages_publish_article'] } };
  await privateJson(filename, original);
  await installClaudePermissions(options);
  const result = JSON.parse(await readFile(filename, 'utf8'));
  // The user's own ask and deny rules stay, and still win over the added allow.
  assert.deepEqual(result, { ...original, permissions: { ...original.permissions, allow: ['Read', 'mcp__supportpages'],
    ask: ['mcp__supportpages__*', ...rulesFor('supportpages').ask] } });
  const backups = await readdir(path.join(options.configDir, 'backups'));
  assert.equal(backups.length, 1);
  assert.deepEqual(JSON.parse(await readFile(path.join(options.configDir, 'backups', backups[0]), 'utf8')), original);
});

test('custom Claude configuration directory receives the rule', async t => {
  const options = await fixture(t);
  options.env.CLAUDE_CONFIG_DIR = path.join(options.home, 'alternate');
  const result = await installClaudePermissions(options);
  assert.equal(result.filename, path.join(options.env.CLAUDE_CONFIG_DIR, 'settings.json'));
  await assert.rejects(readFile(path.join(options.home, '.claude/settings.json')), { code: 'ENOENT' });
});

test('invalid settings are not overwritten', async t => {
  const options = await fixture(t);
  const directory = path.join(options.home, '.claude');
  await mkdir(directory);
  const filename = path.join(directory, 'settings.json');
  for (const contents of ['broken JSON', 'null', '[]', '{"permissions":{"allow":"*"}}', '{"permissions":{"deny":[42]}}']) {
    await writeFile(filename, contents);
    await assert.rejects(installClaudePermissions(options));
    assert.equal(await readFile(filename, 'utf8'), contents);
  }
});

test('symlinks and wildcard connection names cannot expand the permission change', async t => {
  const options = await fixture(t);
  await mkdir(path.join(options.home, '.claude'));
  const target = path.join(options.home, 'other.json');
  await writeFile(target, '{}');
  await symlink(target, path.join(options.home, '.claude/settings.json'));
  await assert.rejects(installClaudePermissions(options), /unsafe path/);
  assert.equal(await readFile(target, 'utf8'), '{}');
  await assert.rejects(installClaudePermissions({ ...options, name: '*' }), /Invalid SupportPages.io connection name/);
});
