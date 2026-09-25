import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { fixture } from './helpers.mjs';
import { privateJson } from '../scripts/lib/install.mjs';
import { selectClaudeConnection } from '../scripts/lib/claude-connection.mjs';

test('init selects the Claude environment per project and preserves global servers and unrelated choices', async t => {
  const f = await fixture(t), home = path.join(f.root, 'home'), workspace = path.join(f.root, 'product');
  const filename = path.join(home, '.claude.json'), configDir = path.join(home, 'supportpages');
  const before = { mcpServers: { supportpages: { command: 'node' }, 'supportpages-dev': { command: 'node' }, other: { command: 'keep' } },
    projects: { [workspace]: { hasTrustDialogAccepted: true, disabledMcpServers: ['other', 'supportpages'] }, '/another-project': { disabledMcpServers: ['supportpages'] } } };
  await privateJson(filename, before);
  const args = { home, workspace, configDir, env: {}, dev: false };
  assert.equal(await selectClaudeConnection(args), true);
  const after = JSON.parse(await readFile(filename, 'utf8'));
  assert.deepEqual(after.mcpServers, before.mcpServers);
  assert.deepEqual(after.projects['/another-project'], before.projects['/another-project']);
  assert.deepEqual(after.projects[workspace], { hasTrustDialogAccepted: true, disabledMcpServers: ['other', 'supportpages-dev'] });
  assert.equal(await selectClaudeConnection(args), false);
  assert.equal((await readdir(path.join(configDir, 'backups'))).length, 1);
  await selectClaudeConnection({ ...args, dev: true });
  assert.deepEqual(JSON.parse(await readFile(filename, 'utf8')).projects[workspace].disabledMcpServers, ['other', 'supportpages']);
});

test('custom Claude config location is respected and invalid choices are kept', async t => {
  const f = await fixture(t), filename = path.join(f.root, '.claude.json');
  const args = { workspace: f.root, configDir: path.join(f.root, 'config'), env: { CLAUDE_CONFIG_DIR: f.root }, dev: false };
  await selectClaudeConnection(args);
  assert.deepEqual(JSON.parse(await readFile(filename, 'utf8')).projects[f.root].disabledMcpServers, ['supportpages-dev']);
  await privateJson(filename, { projects: { [f.root]: { disabledMcpServers: 'keep invalid value' } } });
  const before = await readFile(filename, 'utf8');
  await assert.rejects(selectClaudeConnection(args), /MCP choices are invalid/);
  assert.equal(await readFile(filename, 'utf8'), before);
});
