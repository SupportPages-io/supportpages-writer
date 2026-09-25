import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile, readFile, lstat, rm, symlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { removeIntegration } from '../scripts/lib/remove.mjs';
import { runCli } from '../scripts/lib/cli.mjs';
import { privateJson, command } from '../scripts/lib/install.mjs';
import { writerAgentFile, codexWriterFile } from '../dist/writer-agent.js';
import { Cancelled } from '../scripts/lib/terminal.mjs';

async function fixture(t, { custom = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'supportpages-remove-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const config = path.join(home, '.config/supportpages');
  const claude = path.join(home, custom ? 'custom-claude' : '.claude');
  const codex = path.join(home, custom ? 'custom-codex' : '.codex');
  const skills = path.join(home, 'engines');
  const env = { ...(custom ? { CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex } : {}) };
  const logs = [], calls = [], servers = {};
  const ui = { line: s => logs.push(s), ok: s => logs.push(s), confirm: async () => true };
  const deps = { home, env, ui, run: async (cmd, args) => {
    calls.push([cmd, args]);
    assert.equal(cmd, 'codex');
    if (args[1] === 'get') return servers[args[2]]
      ? { code: 0, stdout: JSON.stringify({ transport: servers[args[2]] }) }
      : { code: 1, stderr: `No MCP server named '${args[2]}' found.` };
    assert.equal(args[1], 'remove');
    delete servers[args[2]];
    await writeFile(path.join(codex, 'config.toml'), '# other settings retained\n');
    return { code: 0 };
  } };
  const claudeFile = custom ? path.join(claude, '.claude.json') : path.join(home, '.claude.json');
  await mkdir(path.join(skills, 'generate-illustrated-article'), { recursive: true });
  await writeFile(path.join(skills, 'generate-illustrated-article/SKILL.md'), 'engine');
  await symlink(skills, path.join(home, '.rtfm-skills'));
  for (const dir of [claude, codex, path.join(home, '.agents')]) await mkdir(path.join(dir, 'skills'), { recursive: true });
  for (const dir of [claude, path.join(home, '.agents')]) await symlink(path.join(skills, 'generate-illustrated-article'), path.join(dir, 'skills/generate-illustrated-article'));
  await mkdir(path.join(claude, 'agents'), { recursive: true });
  await mkdir(path.join(codex, 'agents'), { recursive: true });
  await writeFile(path.join(claude, 'agents/supportpages-io.md'), writerAgentFile);
  await writeFile(path.join(codex, 'agents/supportpages-io.toml'), codexWriterFile);
  const mcpServers = { unrelated: { command: 'keep-me', args: [] } };
  for (const name of ['supportpages', 'supportpages-dev']) {
    const entry = { command: process.execPath, args: [path.resolve('dist/index.js'), ...(name.endsWith('-dev') ? ['--dev'] : []), '--skills-dir', skills] };
    mcpServers[name] = entry; servers[name] = entry;
    await privateJson(path.join(config, 'installations', `${name}.json`), { version: 2, name, clients: ['claude', 'codex'], skills_dir: skills, api_origin: name.endsWith('-dev') ? 'http://app.lvh.me:3000' : 'https://app.supportpages.io' });
    await privateJson(path.join(config, 'installations', `${name}.mcp.json`), { mcpServers: { [name]: entry } });
  }
  await privateJson(claudeFile, { mcpServers, theme: 'dark', projects: { '/keep': { allowedTools: ['Read'] } } });
  await writeFile(path.join(codex, 'config.toml'), '# other settings retained\n');
  const trace = "'" + path.join(home, '.rtfm-skills/generate-illustrated-article/scripts/trace_hook.sh') + "'";
  await privateJson(path.join(claude, 'settings.json'), { permissions: { allow: ['Read', 'mcp__supportpages__supportpages_publish_article', 'mcp__supportpages-dev__supportpages_publish_article'], deny: ['Bash'] },
    hooks: { PostToolUse: [{ matcher: '*', hooks: [{ command: trace }, { command: 'unrelated trace_hook.sh' }] }] } });
  await privateJson(path.join(config, 'credentials/keep.json'), { private: 'kept' });
  return { root, home, config, claude, codex, claudeFile, skills, deps, logs, calls, servers,
    options: { command: 'remove', 'config-dir': config } };
}
const absent = filename => assert.rejects(lstat(filename), { code: 'ENOENT' });
const json = async filename => JSON.parse(await readFile(filename, 'utf8'));

test('removal disconnects both clients and retires owned files while preserving user data', async t => {
  const f = await fixture(t);
  await symlink('/independent/detect-project', path.join(f.claude, 'skills/detect-project'));
  assert.equal((await removeIntegration(f.options, f.deps)).status, 'removed');
  const config = await json(f.claudeFile);
  assert.deepEqual(Object.keys(config.mcpServers), ['unrelated']);
  assert.equal(config.theme, 'dark');
  assert.deepEqual(config.projects, { '/keep': { allowedTools: ['Read'] } });
  const settings = await json(path.join(f.claude, 'settings.json'));
  assert.deepEqual(settings.permissions, { allow: ['Read'], deny: ['Bash'] });
  assert.deepEqual(settings.hooks.PostToolUse[0].hooks, [{ command: 'unrelated trace_hook.sh' }]);
  for (const filename of [path.join(f.claude, 'agents/supportpages-io.md'), path.join(f.codex, 'agents/supportpages-io.toml'), path.join(f.claude, 'skills/generate-illustrated-article'), path.join(f.config, 'installations/supportpages.json')]) await absent(filename);
  assert.equal(Object.keys(f.servers).length, 0);
  assert.ok((await lstat(path.join(f.claude, 'skills/detect-project'))).isSymbolicLink());
  assert.equal(await readFile(path.join(f.skills, 'generate-illustrated-article/SKILL.md'), 'utf8'), 'engine');
  assert.deepEqual(await json(path.join(f.config, 'credentials/keep.json')), { private: 'kept' });
  assert.equal((await removeIntegration(f.options, f.deps)).status, 'unchanged');
});

test('skills-only cleanup is scoped to Claude and leaves MCP, agents, settings and receipts unchanged', async t => {
  const f = await fixture(t, { custom: true });
  const before = await readFile(f.claudeFile, 'utf8');
  await removeIntegration({ ...f.options, agent: 'claude', 'skills-only': true }, f.deps);
  await absent(path.join(f.claude, 'skills/generate-illustrated-article'));
  assert.equal(await readFile(f.claudeFile, 'utf8'), before);
  assert.equal(await readFile(path.join(f.claude, 'agents/supportpages-io.md'), 'utf8'), writerAgentFile);
  assert.ok((await lstat(path.join(f.home, '.agents/skills/generate-illustrated-article'))).isSymbolicLink());
  assert.deepEqual((await json(path.join(f.config, 'installations/supportpages.json'))).clients, ['claude', 'codex']);
  assert.equal(f.calls.length, 0);
});

test('removing development from one client preserves shared writers and the production connection', async t => {
  const f = await fixture(t, { custom: true });
  await removeIntegration({ ...f.options, agent: 'claude', dev: true }, f.deps);
  const config = await json(f.claudeFile);
  assert.ok(config.mcpServers.supportpages);
  assert.equal(config.mcpServers['supportpages-dev'], undefined);
  assert.deepEqual((await json(path.join(f.config, 'installations/supportpages-dev.json'))).clients, ['codex']);
  assert.equal(await readFile(path.join(f.claude, 'agents/supportpages-io.md'), 'utf8'), writerAgentFile);
  const settings = await json(path.join(f.claude, 'settings.json'));
  assert.deepEqual(settings.permissions.allow, ['Read', 'mcp__supportpages__supportpages_publish_article']);
  assert.equal(settings.hooks.PostToolUse[0].hooks.length, 2);
  assert.equal(f.calls.length, 0);
});

test('declining the review changes no files and invokes no removal command', async t => {
  const f = await fixture(t);
  f.deps.ui.confirm = async () => false;
  await assert.rejects(removeIntegration(f.options, f.deps), Cancelled);
  assert.ok((await json(f.claudeFile)).mcpServers.supportpages);
  assert.ok((await lstat(path.join(f.claude, 'skills/generate-illustrated-article'))).isSymbolicLink());
  assert.ok(!f.calls.some(([, args]) => args[1] === 'remove'));
});

test('changed MCP entries and custom writers survive removal', async t => {
  const f = await fixture(t);
  const config = await json(f.claudeFile);
  config.mcpServers.supportpages.command = '/different/server';
  await privateJson(f.claudeFile, config);
  await writeFile(path.join(f.codex, 'agents/supportpages-io.toml'), '# Custom agent');
  await removeIntegration(f.options, f.deps);
  assert.equal((await json(f.claudeFile)).mcpServers.supportpages.command, '/different/server');
  assert.deepEqual((await json(path.join(f.config, 'installations/supportpages.json'))).clients, ['claude']);
  assert.equal(await readFile(path.join(f.claude, 'agents/supportpages-io.md'), 'utf8'), writerAgentFile);
  assert.equal(await readFile(path.join(f.codex, 'agents/supportpages-io.toml'), 'utf8'), '# Custom agent');
});

test('concurrent configuration changes and failed Codex removal leave retryable receipts', async t => {
  const f = await fixture(t);
  f.deps.ui.confirm = async () => { await privateJson(f.claudeFile, { changed: true }); return true; };
  await assert.rejects(removeIntegration(f.options, f.deps), { code: 'configuration_changed' });
  assert.ok(!f.calls.some(([, args]) => args[1] === 'remove'));
  const g = await fixture(t);
  const original = g.deps.run;
  g.deps.run = async (cmd, args, options) => args[1] === 'remove' ? { code: 1 } : original(cmd, args, options);
  await assert.rejects(removeIntegration(g.options, g.deps), { code: 'remove_failed' });
  assert.deepEqual((await json(path.join(g.config, 'installations/supportpages.json'))).clients, ['claude', 'codex']);
  assert.ok((await json(g.claudeFile)).mcpServers.supportpages);
});

test('remove runs without discovering a repository or creating an API session', async t => {
  const f = await fixture(t);
  const result = await runCli({ ...f.options, agent: 'claude', 'skills-only': true }, { ...f.deps, installRoot: path.resolve('.'),
    sessionFactory: () => assert.fail('No API session needed'), run: () => assert.fail('No client or Git command needed') });
  assert.equal(result.status, 'removed');
});

test('CLI exposes removal and allows explicit unattended cleanup', async t => {
  const f = await fixture(t);
  const result = spawnSync(process.execPath, ['scripts/cli.mjs', 'remove', '--skills-only', '--agent', 'claude', '--config-dir', f.config, '--yes'],
    { encoding: 'utf8', env: { ...process.env, HOME: f.home, CLAUDE_CONFIG_DIR: f.claude, RTFM_SKILLS_DIR: f.skills } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /skill shortcuts removed/);
  const invalid = spawnSync(process.execPath, ['scripts/cli.mjs', 'init', '--yes'], { encoding: 'utf8' });
  assert.equal(invalid.status, 2);
});

test('native Codex removal preserves unrelated TOML and keeps the Claude installation', async t => {
  if (spawnSync('codex', ['--version'], { encoding: 'utf8' }).status !== 0) return t.skip('Codex is not installed');
  const f = await fixture(t, { custom: true });
  const config = path.join(f.codex, 'config.toml');
  let contents = '# keep this comment\nmodel_reasoning_effort = "low"\n[mcp_servers.unrelated]\ncommand = "keep-me"\n';
  for (const [name, entry] of Object.entries(f.servers)) contents += `[mcp_servers.${name}]\ncommand = ${JSON.stringify(entry.command)}\nargs = ${JSON.stringify(entry.args)}\n[mcp_servers.${name}.tools.supportpages_publish_article]\napproval_mode = "approve"\n`;
  await writeFile(config, contents);
  f.deps.env = { ...process.env, ...f.deps.env, HOME: f.home };
  f.deps.run = (cmd, args, settings) => command(cmd, args, settings);
  await removeIntegration({ ...f.options, agent: 'codex' }, f.deps);
  const after = await readFile(config, 'utf8');
  assert.match(after, /# keep this comment/);
  assert.match(after, /model_reasoning_effort = "low"/);
  assert.match(after, /mcp_servers.unrelated/);
  assert.doesNotMatch(after, /supportpages/);
  assert.ok((await json(f.claudeFile)).mcpServers.supportpages);
  assert.deepEqual((await json(path.join(f.config, 'installations/supportpages.json'))).clients, ['claude']);
  assert.equal(await readFile(path.join(f.claude, 'agents/supportpages-io.md'), 'utf8'), writerAgentFile);
});
