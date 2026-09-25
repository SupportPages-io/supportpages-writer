import os from 'node:os';
import path from 'node:path';
import { lstat, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { backup, expand, privateJson } from './install.mjs';
import { retirePublicSkillLinks } from './article-skills.mjs';
import { Cancelled } from './terminal.mjs';
import { fail } from '../../dist/errors.js';
import { claudePermissionRules } from './claude-permissions.mjs';

const clean = value => String(value).replace(/[\p{Cc}\p{Cf}]/gu, '');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const canonical = async filename => { try { return await realpath(filename); } catch { return path.resolve(filename); } };

/** Remove local integrations only; never contact the API or change a product workspace. */
export async function removeIntegration(options, { home = os.homedir(), env = process.env, ui, run }) {
  const configDir = expand(options['config-dir'] ?? path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'supportpages'));
  const directory = path.join(configDir, 'installations');
  const clients = options.agent ? [options.agent] : ['claude', 'codex'];
  const claudeDir = path.resolve(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'));
  const claudeFile = env.CLAUDE_CONFIG_DIR ? path.join(claudeDir, '.claude.json') : path.join(home, '.claude.json');
  const codexDir = path.resolve(env.CODEX_HOME || path.join(home, '.codex'));
  const snapshots = new Map(), edits = new Map(), removals = [], commands = [], descriptions = [];
  async function read(filename) {
    if (snapshots.has(filename)) return snapshots.get(filename);
    // Refuse linked configuration paths, including linked parent directories.
    const base = [configDir, claudeDir, codexDir, home].sort((a, b) => b.length - a.length).find(root => filename.startsWith(root + path.sep)) ?? path.dirname(filename);
    for (let cursor = filename; cursor !== path.dirname(base) && cursor !== path.dirname(cursor); cursor = path.dirname(cursor)) {
      try { if ((await lstat(cursor)).isSymbolicLink()) fail('unsafe_configuration', `Keep the linked configuration path: ${clean(cursor)}`); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    let contents;
    try { contents = await readFile(filename, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; contents = null; }
    snapshots.set(filename, contents);
    return contents;
  }
  async function json(filename) {
    const contents = await read(filename);
    if (contents === null) return null;
    try { const value = JSON.parse(contents); if (object(value)) return value; } catch { /* Safe error without configuration contents. */ }
    fail('invalid_configuration', `Cannot read the configuration at ${clean(filename)}. Repair it before removing the integration.`);
  }
  async function matches(actual, expected) {
    return actual && expected && Array.isArray(actual.args) && Array.isArray(expected.args) &&
      JSON.stringify(actual.args) === JSON.stringify(expected.args) && typeof actual.command === 'string' && typeof expected.command === 'string' &&
      await canonical(actual.command) === await canonical(expected.command);
  }
  let filenames;
  try { filenames = await readdir(directory); } catch (error) { if (error.code !== 'ENOENT') throw error; filenames = []; }
  const records = [];
  for (const filename of filenames.sort()) {
    if (!/^[a-z0-9][a-z0-9_-]{0,79}\.json$/.test(filename)) continue;
    const receiptPath = path.join(directory, filename);
    const receipt = await json(receiptPath);
    if (![1, 2].includes(receipt?.version) || receipt.name !== filename.slice(0, -5) || !Array.isArray(receipt.clients) || receipt.clients.some(client => !['claude', 'codex'].includes(client))) continue;
    const manualPath = path.join(directory, `${receipt.name}.mcp.json`);
    const manual = await json(manualPath);
    const expected = manual?.mcpServers?.[receipt.name];
    const selected = (!options.dev || expected?.args?.includes('--dev') || receipt.name === 'supportpages-dev') &&
      (!options['api-url'] || receipt.api_origin === options['api-url']);
    records.push({ receipt, receiptPath, manualPath, expected, selected, remaining: [...receipt.clients] });
  }
  let claude, settings;
  const rules = new Set();
  if (!options['skills-only']) {
    for (const record of records.filter(record => record.selected)) {
      const { receipt, expected } = record;
      for (const client of receipt.clients.filter(client => clients.includes(client))) {
        let actual;
        if (client === 'claude') {
          claude ??= await json(claudeFile) ?? {};
          if (claude.mcpServers !== undefined && !object(claude.mcpServers)) fail('invalid_configuration', 'Claude MCP settings are invalid. Repair them before removal.');
          actual = claude.mcpServers?.[receipt.name];
        } else {
          const filename = path.join(codexDir, 'config.toml');
          if (await read(filename) !== null) {
            const result = await run('codex', ['mcp', 'get', receipt.name, '--json'], { capture: true, env: { ...env, CODEX_HOME: codexDir } });
            if (result.code === 0) {
              try { const value = JSON.parse(result.stdout); actual = value.transport ?? value; }
              catch { fail('invalid_configuration', 'Codex returned invalid MCP configuration. No integrations were removed.'); }
            } else if (result.code !== 1 || !/No MCP server .*found/i.test(result.stderr ?? '')) {
              fail('client_unavailable', 'Could not inspect Codex. Restore its command, or use --agent claude to remove only Claude integration.');
            }
          }
        }
        if (actual && !await matches(actual, expected)) {
          ui.line(`Kept changed or unmanaged ${client} connection: ${clean(receipt.name)}`);
          continue;
        }
        if (actual) {
          descriptions.push(`${client === 'claude' ? 'Claude Code' : 'Codex'} connection: ${receipt.name}`);
          if (client === 'claude') { delete claude.mcpServers[receipt.name]; edits.set(claudeFile, claude); }
          else commands.push({ name: receipt.name, filename: path.join(codexDir, 'config.toml') });
        }
        if (client === 'claude') {
          // Older setups added only the publish rule; current ones allow the server and ask for removals.
          const current = claudePermissionRules(receipt.name);
          for (const rule of [`mcp__${receipt.name}__supportpages_publish_article`, ...current.allow, ...current.ask]) rules.add(rule);
        }
        record.remaining = record.remaining.filter(value => value !== client);
      }
      if (!record.remaining.length && (!options.agent || record.receipt.clients.includes(options.agent))) {
        removals.push(record.receiptPath, record.manualPath);
        descriptions.push(`Saved integration registration: ${record.receipt.name}`);
      } else if (record.remaining.length !== record.receipt.clients.length) edits.set(record.receiptPath, { ...record.receipt, clients: record.remaining });
    }
    for (const client of clients) {
      // Writer definitions and the trace hook are shared by all API connections.
      if (records.some(record => record.remaining.includes(client)) ||
          (options.dev || options['api-url']) && !records.some(record => record.selected && record.receipt.clients.includes(client))) continue;
      const filename = path.join(client === 'claude' ? claudeDir : codexDir, 'agents', `supportpages-io.${client === 'claude' ? 'md' : 'toml'}`);
      const contents = await read(filename);
      const marker = client === 'claude' ? '<!-- Managed by SupportPages: article writer v1 -->' : '# Managed by SupportPages: article writer v1';
      if (contents?.includes(marker)) { removals.push(filename); descriptions.push(`${client === 'claude' ? 'Claude Code' : 'Codex'} SupportPages Writer agent`); }
    }
    if (clients.includes('claude')) {
      const filename = path.join(claudeDir, 'settings.json');
      settings = await json(filename);
      if (settings) {
        const before = JSON.stringify(settings);
        for (const key of ['allow', 'ask']) {
          if (Array.isArray(settings.permissions?.[key])) settings.permissions[key] = settings.permissions[key].filter(rule => !rules.has(rule));
        }
        if ((!options.dev && !options['api-url'] || records.some(record => record.selected && record.receipt.clients.includes('claude'))) && !records.some(record => record.remaining.includes('claude')) && Array.isArray(settings.hooks?.PostToolUse)) {
          const skillDirs = records.map(record => record.receipt.skills_dir).filter(value => typeof value === 'string');
          // Hooks name the engine by its managed `current` path so they survive updates.
          const stable = skillDirs.map(dir => dir.replace(/\/versions\/[^/]+\/mcp\/(skills|engine)$/, '/current/mcp/$1'));
          const roots = [path.join(home, '.rtfm-skills'), ...skillDirs, ...stable];
          const ours = command => roots.some(root => ['sh', 'js'].some(ext => String(command ?? '').includes(path.join(root, `generate-illustrated-article/scripts/trace_hook.${ext}`))));
          settings.hooks.PostToolUse = settings.hooks.PostToolUse.map(group => Array.isArray(group.hooks)
            ? { ...group, hooks: group.hooks.filter(item => !ours(item.command)) } : group)
            .filter(group => !Array.isArray(group.hooks) || group.hooks.length);
        }
        if (JSON.stringify(settings) !== before) { edits.set(filename, settings); descriptions.push('SupportPages.io Claude permissions and unused trace hook'); }
      }
    }
  }
  const skillOptions = records.filter(record => record.selected).map(record => ({ home, env, clients: options.agent ? clients : [...new Set([...record.receipt.clients, 'codex', 'claude'])],
    directory: record.receipt.skills_dir ?? record.expected?.args?.[record.expected.args.indexOf('--skills-dir') + 1] }));
  if (!options.dev && !options['api-url']) skillOptions.push({ home, env, clients, directory: expand(options['skills-dir'] ?? env.RTFM_SKILLS_DIR ?? path.join(home, '.rtfm-skills')) });
  const links = new Set();
  for (const args of skillOptions) for (const filename of await retirePublicSkillLinks({ ...args, dryRun: true })) links.add(filename);
  descriptions.push(...[...links].map(filename => `Skill shortcut: ${filename}`));
  if (!descriptions.length && !edits.size) { ui.ok('No managed SupportPages Writer integration found to remove.'); return { status: 'unchanged' }; }
  ui.intro?.('SupportPages Writer · Remove integration');
  for (const description of descriptions) ui.line(clean(description));
  ui.line('Projects, article files, saved repository links, downloaded engines, saved credentials and SupportPages Writer will be kept.');
  if (!options.yes && !await ui.confirm(options['skills-only'] ? 'Remove these SupportPages.io skill shortcuts?' : 'Remove these SupportPages Writer integrations?', false)) throw new Cancelled('Removal cancelled. Your integration was kept.');
  // Do not overwrite edits made while the user reviewed the removal list.
  for (const [filename, before] of snapshots) {
    let current;
    try { current = await readFile(filename, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; current = null; }
    if (current !== before) fail('configuration_changed', 'Configuration changed during review. Rerun supportpages remove to review it again.');
  }
  for (const item of commands) {
    await backup(item.filename, path.join(configDir, 'backups'));
    const result = await run('codex', ['mcp', 'remove', item.name], { capture: true, env: { ...env, CODEX_HOME: codexDir } });
    if (result.code !== 0) fail('remove_failed', `Codex could not remove ${item.name}. Its installation receipt was kept; rerun supportpages remove to finish.`);
  }
  for (const [filename, value] of edits) { await backup(filename, path.join(configDir, 'backups')); await privateJson(filename, value); }
  for (const args of skillOptions) await retirePublicSkillLinks(args);
  for (const filename of removals) { await backup(filename, path.join(configDir, 'backups')); await rm(filename, { force: true }); }
  ui.ok(options['skills-only'] ? 'SupportPages.io skill shortcuts removed.' : 'SupportPages Writer integrations removed.');
  ui.line('Restart existing coding-agent sessions to unload the removed integrations and cached skills.');
  return { status: 'removed' };
}
