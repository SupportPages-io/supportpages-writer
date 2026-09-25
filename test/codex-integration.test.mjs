import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm, readdir, symlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { installCodexIntegration } from '../scripts/lib/codex-integration.mjs';
import { withCodexConfig } from '../scripts/lib/codex-config.mjs';
import { backup } from '../scripts/lib/install.mjs';
import { codexWriterFile } from '../dist/writer-agent.js';

async function fixture(t, name = 'supportpages-dev') {
  const home = await mkdtemp(path.join(os.tmpdir(), 'supportpages-codex-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const directory = path.join(home, 'custom-codex');
  await mkdir(directory);
  const filename = path.join(directory, 'config.toml');
  await writeFile(filename, `# Preserve\n[mcp_servers.${name}]\ncommand = "true"\n`, { mode: 0o600 });
  const requests = [], logs = [];
  const server = { command: 'true', enabled: true };
  const state = { config: { model: 'parent-model', sandbox_mode: 'workspace-write', approval_policy: 'on-request', mcp_servers: { [name]: server } },
    layers: [{ name: { type: 'user', file: await realpath(filename) }, version: 'original-version' }] };
  const options = { home, env: { ...process.env, HOME: home, CODEX_HOME: directory }, name, configDir: path.join(home, 'supportpages'), backup, ui: { line: value => logs.push(value) },
    codexConfig: async (config, action) => {
      assert.equal(config.env.CODEX_HOME, directory);
      return action(async (method, params) => {
        requests.push({ method, params });
        if (method === 'config/read') return state;
        assert.equal(method, 'config/batchWrite');
        // Apply the edits to the fixture so a repeat run sees them.
        for (const { keyPath, value } of params.edits) {
          const [, , ...rest] = keyPath.split('.');
          if (rest[0] === 'tools') { server.tools ??= {}; (server.tools[rest[1]] ??= {}).approval_mode = value; }
          else server[rest[0]] = value;
        }
        return { status: 'ok' };
      });
    } };
  return { home, directory, filename, requests, logs, server, state, options };
}

test('Codex installs a named personal writer and precisely scoped publishing policy', async t => {
  const f = await fixture(t);
  const result = await installCodexIntegration(f.options);
  assert.equal(result.agent.filename, path.join(f.directory, 'agents/supportpages-io.toml'));
  assert.equal(await readFile(result.agent.filename, 'utf8'), codexWriterFile);
  assert.equal(result.skill.filename, path.join(f.directory, 'skills/supportpages/SKILL.md'));
  assert.equal(await readFile(result.skill.filename, 'utf8'), await readFile(new URL('../scripts/skills/supportpages/SKILL.md', import.meta.url), 'utf8'));
  assert.match(codexWriterFile, /name = "supportpages-io"/);
  assert.match(codexWriterFile, /developer_instructions = /);
  assert.doesNotMatch(codexWriterFile, /^(model|model_reasoning_effort|sandbox_mode|approval_policy)\s*=/m);
  assert.deepEqual(f.requests[1], { method: 'config/batchWrite', params: {
    filePath: await realpath(f.filename), expectedVersion: 'original-version', edits: [
      { keyPath: 'mcp_servers.supportpages-dev.tools.supportpages_publish_article.approval_mode', value: 'approve', mergeStrategy: 'upsert' },
      { keyPath: 'mcp_servers.supportpages-dev.default_tools_approval_mode', value: 'approve', mergeStrategy: 'upsert' },
      { keyPath: 'mcp_servers.supportpages-dev.tools.supportpages_delete_article.approval_mode', value: 'prompt', mergeStrategy: 'upsert' },
      { keyPath: 'mcp_servers.supportpages-dev.tools.supportpages_unpublish_article.approval_mode', value: 'prompt', mergeStrategy: 'upsert' },
    ],
  } });
  assert.equal((await readdir(path.join(f.options.configDir, 'backups'))).length, 1);
  const again = await installCodexIntegration(f.options);
  assert.equal(again.agent.changed, false); assert.equal(again.permission.changed, false);
  assert.equal(again.skill.changed, false);
  assert.equal(f.requests.filter(item => item.method === 'config/batchWrite').length, 1);
});

test('Codex setup preserves explicit tool and server restrictions', async t => {
  for (const restrictions of [
    { tools: { supportpages_publish_article: { approval_mode: 'prompt' } } },
    { tools: { supportpages_publish_article: { approval_mode: 'auto' } } },
    { disabled_tools: ['supportpages_publish_article'] }, { enabled_tools: ['supportpages_status'] },
    { default_tools_approval_mode: 'writes' }, { enabled: false },
  ]) {
    const f = await fixture(t); Object.assign(f.server, restrictions);
    const result = await installCodexIntegration(f.options);
    assert.equal(result.permission.keptExistingPolicy, true);
    // Restrictions are kept: nothing is approved, only removals are made to ask.
    const edits = f.requests.filter(item => item.method === 'config/batchWrite').flatMap(item => item.params.edits);
    assert.ok(edits.every(edit => edit.value === 'prompt' && /supportpages_(delete|unpublish)_article/.test(edit.keyPath)), JSON.stringify(edits));
  }
});

test('Codex setup refuses unowned agent files and symlinked settings', async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.directory, 'agents'));
  const writer = path.join(f.directory, 'agents/supportpages-io.toml');
  await writeFile(writer, 'name = "custom"');
  await assert.rejects(installCodexIntegration(f.options), /custom agent already exists/);
  assert.equal(await readFile(writer, 'utf8'), 'name = "custom"');
  assert.equal(f.requests.length, 0);
  await rm(writer);
  const target = path.join(f.home, 'other.toml');
  await writeFile(target, '# untouched'); await rm(f.filename); await symlink(target, f.filename);
  await assert.rejects(installCodexIntegration(f.options), /unsafe path/);
  assert.equal(await readFile(target, 'utf8'), '# untouched');
});

test('Codex setup never changes a missing connection or a config without a version', async t => {
  for (const missing of ['connection', 'version']) {
    const f = await fixture(t);
    if (missing === 'connection') f.state.config.mcp_servers = {};
    else delete f.state.layers[0].version;
    await assert.rejects(installCodexIntegration(f.options));
    assert.equal(f.requests.filter(item => item.method === 'config/batchWrite').length, 0);
  }
});

const nativeCodex = spawnSync('codex', ['--version'], { encoding: 'utf8' }).status === 0;
test('native Codex edits inline TOML without changing unrelated settings', { skip: !nativeCodex }, async t => {
  const f = await fixture(t, 'supportpages-custom');
  const original = '# Keep this comment\nmodel = "parent-model"\napproval_policy = "on-request"\nsandbox_mode = "workspace-write"\nmcp_servers = { supportpages-custom = { command = "true" } }\n';
  await writeFile(f.filename, original);
  const options = { ...f.options, codexConfig: withCodexConfig };
  const result = await installCodexIntegration(options);
  assert.equal(result.permission.changed, true);
  const updated = await readFile(f.filename, 'utf8');
  assert.match(updated, /# Keep this comment/);
  assert.match(updated, /approval_mode = "approve"/);
  const state = await withCodexConfig({ env: options.env, cwd: f.directory }, request => request('config/read', { includeLayers: true }));
  assert.equal(state.config.model, 'parent-model'); assert.equal(state.config.approval_policy, 'on-request');
  assert.equal(state.config.sandbox_mode, 'workspace-write');
  assert.equal(state.config.mcp_servers['supportpages-custom'].tools.supportpages_publish_article.approval_mode, 'approve');
  assert.equal(state.config.mcp_servers['supportpages-custom'].default_tools_approval_mode, 'approve');
  for (const tool of ['supportpages_delete_article', 'supportpages_unpublish_article']) {
    assert.equal(state.config.mcp_servers['supportpages-custom'].tools[tool].approval_mode, 'prompt');
  }
  assert.equal((await installCodexIntegration(options)).permission.changed, false);
  assert.equal(await readFile(f.filename, 'utf8'), updated);
  const discovered = await withCodexConfig({ env: options.env, cwd: f.directory }, request => request('skills/list', { cwds: [f.directory], forceReload: true }));
  const skill = discovered.data.flatMap(item => item.skills).find(item => item.name === 'supportpages');
  assert.ok(skill, 'native Codex discovers the installed coordination skill');
  assert.equal(await realpath(skill.path), await realpath(result.skill.filename));
  assert.equal(skill.enabled, true);
});

test('native Codex registration refresh preserves disabled tools and explicit approval rules', { skip: !nativeCodex }, async t => {
  const f = await fixture(t);
  await writeFile(f.filename, '# Keep restrictions\n[mcp_servers.supportpages-dev]\ncommand = "old-command"\nargs = ["old"]\ndisabled_tools = ["supportpages_publish_article"]\n[mcp_servers.supportpages-dev.tools.supportpages_publish_article]\napproval_mode = "prompt"\n');
  const result = await installCodexIntegration({ ...f.options, codexConfig: withCodexConfig, registration: { command: 'new-command', args: ['new', 'two'] } });
  assert.equal(result.permission.keptExistingPolicy, true);
  const state = await withCodexConfig({ env: f.options.env, cwd: f.directory }, request => request('config/read', { includeLayers: true }));
  const server = state.config.mcp_servers['supportpages-dev'];
  assert.equal(server.command, 'new-command'); assert.deepEqual(server.args, ['new', 'two']);
  assert.deepEqual(server.disabled_tools, ['supportpages_publish_article']);
  assert.equal(server.tools.supportpages_publish_article.approval_mode, 'prompt');
  assert.match(await readFile(f.filename, 'utf8'), /# Keep restrictions/);
});
