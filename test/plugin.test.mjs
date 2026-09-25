import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { buildPlugin } from '../scripts/build-plugin.mjs';
import { writerAgentFile } from '../dist/writer-agent.js';

const json = async file => JSON.parse(await readFile(file, 'utf8'));

async function findSymlinks(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) found.push(file);
    else if (entry.isDirectory()) found.push(...await findSymlinks(file));
  }
  return found;
}

test('the plugin tree carries the built server, engine, generated writer agent and matching manifests', async t => {
  const out = await mkdtemp(path.join(os.tmpdir(), 'supportpages-plugin-'));
  t.after(() => rm(out, { recursive: true, force: true }));
  const { version } = await buildPlugin({ out, install: false });
  const pkg = await json('package.json');
  const plugin = await json(path.join(out, '.claude-plugin/plugin.json'));
  assert.equal(version, pkg.version);
  assert.equal(plugin.version, pkg.version);
  assert.equal(plugin.license, pkg.license);

  // The marketplace on main installs this plugin by name from the plugin branch.
  const marketplace = await json('.claude-plugin/marketplace.json');
  assert.deepEqual(marketplace.plugins.map(entry => entry.name), [plugin.name]);
  assert.equal(marketplace.plugins[0].source.ref, 'plugin');

  // Plugin agents are namespaced <plugin>:<agent>; the server is told the plugin name.
  const server = (await json(path.join(out, '.mcp.json'))).mcpServers.supportpages;
  assert.deepEqual(server.args, ['${CLAUDE_PLUGIN_ROOT}/dist/index.js']);
  assert.equal(server.env.SUPPORTPAGES_PLUGIN, plugin.name);
  assert.equal(await readFile(path.join(out, 'agents/supportpages-io.md'), 'utf8'), writerAgentFile);

  // Every hook command names a file the tree ships.
  const hooks = (await json(path.join(out, 'hooks/hooks.json'))).hooks;
  const commands = Object.values(hooks).flat().flatMap(group => group.hooks.map(hook => hook.command));
  assert.ok(commands.length >= 2);
  for (const command of commands) {
    const [, relative] = command.match(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"]+)"/) ?? [];
    assert.ok(relative, command);
    assert.ok((await lstat(path.join(out, relative))).isFile(), relative);
  }
  for (const name of ['dist/index.js', 'engine/generate-illustrated-article/SKILL.md', 'engine/detect-project/SKILL.md', 'LICENSE', 'NOTICE']) {
    assert.ok((await lstat(path.join(out, name))).isFile(), name);
  }
  // npm drops symlinks from packages, and the same engine ships through npm.
  assert.deepEqual(await findSymlinks(path.join(out, 'engine')), []);
});

test('plugin sessions launch the namespaced writer agent', () => {
  const probe = "import('./dist/writer-agent.js').then(m => console.log(JSON.stringify([m.writerSubagentType, m.writerLaunchInstruction.includes('subagent_type=\"' + m.writerSubagentType + '\"')])))";
  const plain = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8', env: { ...process.env, SUPPORTPAGES_PLUGIN: '' } });
  assert.deepEqual(JSON.parse(plain.stdout), ['supportpages-io', true]);
  const plugin = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8', env: { ...process.env, SUPPORTPAGES_PLUGIN: 'supportpages-writer' } });
  assert.deepEqual(JSON.parse(plugin.stdout), ['supportpages-writer:supportpages-io', true]);
});

test('the mcp command starts the stdio server through the package command', async () => {
  const result = spawnSync(process.execPath, ['scripts/cli.mjs', 'mcp', '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: supportpages-mcp/);
});
