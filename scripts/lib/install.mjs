import { chmod, copyFile, lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { ARTICLE_SKILLS, installArticleSkills, retirePublicSkillLinks } from './article-skills.mjs';
import { installClaudeWriter } from './claude-writer.mjs';
import { installClaudePermissions } from './claude-permissions.mjs';
import { installCodexIntegration } from './codex-integration.mjs';
import { ensureRenderer } from './renderer.mjs';
import { claudePluginInstalled } from './claude-plugin.mjs';
import { pathToFileURL } from 'node:url';

export const SKILLS = ARTICLE_SKILLS;
const digest = text => createHash('sha256').update(text).digest('hex').slice(0, 12);
export const exists = async file => { try { await lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
export const expand = (value, home = os.homedir()) => path.resolve(value === '~' ? home : value.startsWith('~/') ? path.join(home, value.slice(2)) : value);
export const serverName = (workspace, origin) => `supportpages-${path.basename(workspace).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 28) || 'project'}-${digest(workspace + '\n' + origin).slice(0, 8)}`;

/** No shell interpolation; credentials are not inherited by install/build/client subprocesses. */
export function command(command, args = [], { cwd, capture = false, env = process.env } = {}) {
  const safeEnv = { ...env };
  delete safeEnv.SUPPORTPAGES_API_TOKEN;
  delete safeEnv.SUPPORTPAGES_API_TOKEN_FILE;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: safeEnv, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    let stdout = '', stderr = '';
    child.stdout?.on('data', chunk => { if (stdout.length < 128_000) stdout += chunk; });
    child.stderr?.on('data', chunk => { if (stderr.length < 128_000) stderr += chunk; });
    child.once('error', error => error.code === 'ENOENT' ? resolve({ code: 127, stdout: '', stderr: '' }) : reject(error));
    child.once('exit', code => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function noSymlinks(file) {
  const absolute = path.resolve(file);
  // Resolve system-level aliases (/tmp on macOS) once, then reject application
  // symlinks below the existing parent when securing credential files.
  if (await exists(absolute) && (await lstat(absolute)).isSymbolicLink()) throw new Error(`Refusing to replace a symlink: ${absolute}`);
}
export async function privateDirectory(dir) {
  await noSymlinks(dir);
  if (await exists(dir)) {
    const info = await lstat(dir);
    if (!info.isDirectory() || (process.getuid && info.uid !== process.getuid())) throw new Error(`Not an owned directory: ${dir}`);
  }
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
}
export async function privateJson(file, value) {
  await privateDirectory(path.dirname(file));
  await noSymlinks(file);
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = await open(temporary, 'wx', 0o600);
  try { await fd.writeFile(JSON.stringify(value, null, 2) + '\n'); await fd.sync(); }
  finally { await fd.close(); }
  try { await rename(temporary, file); } finally { await rm(temporary, { force: true }); }
}
export async function backup(file, dir) {
  if (!await exists(file)) return null;
  await noSymlinks(file);
  if (!(await lstat(file)).isFile()) throw new Error(`Cannot back up a non-file: ${file}`);
  await privateDirectory(dir);
  const target = path.join(dir, `${path.basename(file)}.${Date.now()}.${randomUUID()}.bak`);
  await copyFile(file, target, constants.COPYFILE_EXCL);
  await chmod(target, 0o600);
  return target;
}

/** The article engine ships inside the package, beside dist/ and scripts/. */
export const bundledEngine = installRoot => path.join(installRoot, 'engine');

/** Map a registered engine path from another managed release (mcp/skills in older
 * releases, mcp/engine now) to this release's engine. Other paths are kept. */
export async function installationSkills(installRoot, selected) {
  let directory;
  try { directory = await realpath(selected); } catch (error) { if (error.code === 'ENOENT') return selected; throw error; }
  const version = path.dirname(installRoot);
  if (path.basename(installRoot) === 'mcp' && path.basename(path.dirname(version)) === 'versions') {
    const root = path.dirname(path.dirname(version));
    const relative = path.relative(root, directory).split(path.sep);
    // Earlier setups also kept skills copies in the shared data directory (<data>/skills/<name>).
    const shared = path.relative(path.join(path.dirname(root), 'skills'), directory).split(path.sep);
    const managed = (relative.length === 4 && relative[0] === 'versions' && relative[2] === 'mcp' && ['skills', 'engine'].includes(relative[3])) ||
      (shared.length === 1 && shared[0] !== '' && shared[0] !== '..');
    if (managed && await exists(path.join(bundledEngine(installRoot), 'generate-illustrated-article', 'SKILL.md'))) directory = await realpath(bundledEngine(installRoot));
  }
  return directory;
}

export async function findSkills(explicit, { home, installRoot }) {
  if (explicit) return { directory: await installationSkills(installRoot, await realpath(expand(explicit, home))) };
  const engine = bundledEngine(installRoot);
  if (!await exists(engine)) throw new Error(`The article engine is missing from this installation: ${engine}. Reinstall SupportPages Writer.`);
  return { directory: await realpath(engine) };
}

export async function checkSkills(directory) {
  for (const name of SKILLS) {
    if (!await exists(path.join(directory, name, 'SKILL.md'))) throw new Error(`The article engine is missing ${name}/SKILL.md: ${directory}`);
  }
}

/** Prefer the managed `current` link over an immutable versions/<release> path, so
 * commands written into client settings keep working after an update. */
export async function stablePath(file, installRoot) {
  const version = path.dirname(installRoot);
  if (path.basename(installRoot) !== 'mcp' || path.basename(path.dirname(version)) !== 'versions') return file;
  const current = path.join(path.dirname(path.dirname(version)), 'current');
  try {
    if (await realpath(current) !== await realpath(version)) return file;
  } catch (error) { if (error.code === 'ENOENT') return file; throw error; }
  const relative = path.relative(version, file);
  return relative.startsWith('..') || path.isAbsolute(relative) ? file : path.join(current, relative);
}

export function registration(client, name, serverArgs, node = process.execPath) {
  if (client === 'codex') return { command: 'codex', args: ['mcp', 'add', name, '--', node, ...serverArgs] };
  if (client === 'claude') return { command: 'claude', args: ['mcp', 'add', '--transport', 'stdio', '--scope', 'user', name, '--', node, ...serverArgs] };
  throw new Error('Unsupported coding client.');
}

export async function runInstaller(options, dependencies) {
  const { ui: suppliedUi, installRoot, home = os.homedir(), run = command, env = process.env } = dependencies;
  // Setup writes this copy's path into client configuration; npx's cache is temporary.
  if (installRoot.split(path.sep).includes('_npx')) {
    throw new Error('Run setup from an installed copy: npm install -g supportpages-writer, then supportpages setup. npx runs from a temporary cache that npm may delete.');
  }
  // Setup and init run this inside their own wizard frame: no step headers, and no
  // standalone-installer indentation on the lines that remain.
  const ui = options.embedded ? { ...suppliedUi, step: () => {}, ok: () => {}, line: text => suppliedUi.line(String(text).replace(/^\s+/, '')) } : suppliedUi;
  const configDir = expand(options['config-dir'] ?? path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'supportpages'), home);
  const dataDir = expand(options['data-dir'] ?? path.join(env.XDG_DATA_HOME || path.join(home, '.local/share'), 'supportpages'), home);
  const yes = options.yes === true;
  const confirm = async (label, fallback = true) => yes ? fallback : ui.confirm(label, fallback);
  const checked = async (cmd, args, settings = {}) => {
    const result = await run(cmd, args, settings);
    if (result.code !== 0) throw new Error(`${path.basename(cmd)} failed (exit ${result.code}). Fix the reported issue and rerun ./install.sh; completed steps are kept.`);
    return result;
  };
  if (!options.embedded) ui.line('\n  SupportPages.io\n  Local articles. Your coding agent. One place to publish.\n');
  ui.step(1, 'Choose your coding client');
  if (yes && !options.client) throw new Error('--yes requires --client.');
  const available = [];
  for (const client of ['codex', 'claude']) {
    if ((await run(client, ['--version'], { capture: true })).code === 0) available.push(client);
  }
  let client = options.client;
  if (!client) {
    const choices = [...available.map(value => ({ value, label: value === 'codex' ? 'Codex' : 'Claude Code' })), ...(available.length === 2 ? [{ value: 'both', label: 'Both' }] : []), { value: 'manual', label: 'Another MCP client — show configuration' }];
    client = await ui.choose('Where will you use SupportPages.io?', choices, available.length === 2 ? 2 : 0);
  }
  if (!['codex', 'claude', 'both', 'manual'].includes(client)) throw new Error('--client must be codex, claude, both, or manual.');
  let clients = client === 'both' ? ['codex', 'claude'] : client === 'manual' ? [] : [client];
  if (clients.includes('claude') && await claudePluginInstalled({ home, env })) {
    ui.line('  Claude Code already has the SupportPages Writer plugin, which provides the server and writer; skipping a second Claude registration.');
    clients = clients.filter(name => name !== 'claude');
  }
  for (const name of clients) if (!available.includes(name)) throw new Error(`${name} is not installed or is not on PATH. Install it first, or choose --client manual.`);
  ui.ok(client === 'manual' ? 'manual configuration' : client);

  ui.step(2, 'Check prerequisites and build the server');
  for (const executable of ['npm', 'git']) {
    const result = await run(executable, ['--version'], { capture: true });
    if (result.code !== 0) {
      if (executable === 'npm' && await exists(path.resolve(installRoot, '../runtime/bin/npm'))) throw new Error('Missing bundled npm. Reinstall SupportPages Writer, then rerun setup.');
      throw new Error(`Missing ${executable}. Install it and rerun setup. Published SupportPages Writer releases include Node and npm; Git must be installed separately.`);
    }
  }
  if (!options['skip-dependencies']) {
    if (await exists(path.join(installRoot, 'src/index.ts'))) {
      await checked('npm', ['ci', '--no-audit', '--no-fund'], { cwd: installRoot });
      await checked('npm', ['run', 'build'], { cwd: installRoot });
    } else if (!await exists(path.join(installRoot, 'node_modules/@modelcontextprotocol/sdk'))) {
      await checked('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: installRoot });
    }
  }
  if (!await exists(path.join(installRoot, 'dist/index.js'))) throw new Error('The server is not built. Run npm ci && npm run build, or rerun without --skip-dependencies.');
  const { apiOrigin, defaultOrigin, developmentMode } = await import(pathToFileURL(path.join(installRoot, 'dist/api.js')).href);
  const dev = options.dev ?? developmentMode(env.SUPPORTPAGES_DEV);
  const origin = apiOrigin(options['api-url'] ?? env.SUPPORTPAGES_API_URL ?? defaultOrigin(dev), dev);
  await privateDirectory(configDir);
  const name = options.name ?? (dev ? 'supportpages-dev' : 'supportpages');
  if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(name)) throw new Error('--name must contain 1–80 lowercase letters, digits, underscores or hyphens.');
  const receiptPath = path.join(configDir, 'installations', `${name}.json`);
  const prior = await exists(receiptPath) ? JSON.parse(await readFile(receiptPath, 'utf8')) : null;
  if (prior && prior.api_origin !== origin) throw new Error('This connection name is already assigned to another API origin. Choose a different --name.');
  const receipt = { version: 2, api_origin: origin, name, clients: prior?.name === name ? [...(prior.clients ?? [])] : [] };
  ui.ok('Prerequisites ready; server built');

  ui.step(3, 'Prepare the article engine');
  const skills = await findSkills(options['skills-dir'], { home, installRoot });
  await checkSkills(skills.directory);
  let previousDirectory = prior?.skills_dir;
  const previousConfig = path.join(configDir, 'installations', `${name}.mcp.json`);
  if (!previousDirectory && prior && await exists(previousConfig)) {
    const args = JSON.parse(await readFile(previousConfig, 'utf8')).mcpServers?.[name]?.args ?? [];
    const index = args.indexOf('--skills-dir');
    if (index >= 0 && typeof args[index + 1] === 'string') previousDirectory = args[index + 1];
  }
  if (!options['skip-skills']) {
    if (client === 'claude' || client === 'both') await backup(path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'settings.json'), path.join(configDir, 'backups'));
    if (!options.embedded) ui.line(`  Using ${skills.directory}`);
    const node = dependencies.node ?? process.execPath;
    const hook = await stablePath(path.join(skills.directory, 'generate-illustrated-article', 'scripts', 'trace_hook.js'), installRoot);
    await installArticleSkills({ home, client, directory: skills.directory, previousDirectory, writeJson: privateJson, env, dataDir, hookCommand: [node, hook] });
    if (!await ensureRenderer(skills.directory, run, { node, ui })) {
      throw new Error('Chromium for article screenshots could not be downloaded. Check your network connection, then rerun setup; completed steps are kept.');
    }
  } else {
    await retirePublicSkillLinks({ home, clients: client === 'both' ? ['claude', 'codex'] : [client === 'manual' ? 'codex' : client], directory: skills.directory, previousDirectory, env });
  }
  receipt.skills_dir = skills.directory;
  ui.ok(options['skip-skills'] ? 'Using the existing article engine (preparation skipped)' : 'Article engine and renderer ready');

  ui.step(4, 'Connect your coding client');
  if (clients.includes('claude')) {
    const agent = await installClaudeWriter({ home, env });
    ui.line(options.embedded ? 'Added SupportPages Writer to Claude Code.' : `  SupportPages Writer agent available to Claude Code: ${agent.filename}`);
  }
  const serverArgs = [path.join(installRoot, 'dist/index.js'), ...(dev ? ['--dev'] : []), '--api-url', origin, '--skills-dir', skills.directory, '--config-dir', configDir];
  const manual = { mcpServers: { [name]: { command: dependencies.node ?? process.execPath, args: serverArgs } } };
  const manualPath = path.join(configDir, 'installations', `${name}.mcp.json`);
  await privateJson(manualPath, manual);
  for (const selected of clients) {
    const existing = await run(selected, ['mcp', 'get', name, ...(selected === 'codex' ? ['--json'] : [])], { capture: true });
    if (existing.code === 127) throw new Error(`${selected} is no longer available on PATH.`);
    if (existing.code === 0) {
      const managed = prior?.name === name && prior?.clients?.includes(selected);
      if (yes && !managed) throw new Error(`An existing ${selected} MCP entry named ${name} was not created by this installer. Use --name to choose a different name.`);
      if (!yes && !(options.embedded && managed) && !await confirm(`Update the existing ${selected} entry ${name}?`, Boolean(managed))) {
        if (options.embedded) throw new Error(`Could not register ${selected}: the existing entry was kept. Choose a different connection with the advanced installer.`);
        ui.line(`  Kept the existing ${selected} entry. Manual configuration: ${manualPath}`);
        continue;
      }
    }
    const configFile = selected === 'codex' ? path.join(env.CODEX_HOME || path.join(home, '.codex'), 'config.toml') : (env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(home, '.claude.json'));
    const backupPath = await backup(configFile, path.join(configDir, 'backups'));
    if (existing.code === 0 && selected === 'claude') {
      await checked('claude', ['mcp', 'remove', '--scope', 'user', name], { capture: true });
    }
    const registrationCommand = registration(selected, name, serverArgs, dependencies.node ?? process.execPath);
    const updatingCodex = selected === 'codex' && existing.code === 0;
    if (updatingCodex) await (dependencies.installCodex ?? installCodexIntegration)({ home, env, name, configDir, backup, ui, announcePermission: !options.embedded,
      registration: { command: dependencies.node ?? process.execPath, args: serverArgs } });
    const result = updatingCodex ? { code: 0 } : await run(registrationCommand.command, registrationCommand.args, { capture: true });
    if (result.code !== 0) throw new Error(`Could not register ${selected}. Manual configuration: ${manualPath}.${backupPath ? ` Your original configuration is backed up at ${backupPath}.` : ''}`);
    if (!receipt.clients.includes(selected)) receipt.clients.push(selected);
    await privateJson(receiptPath, receipt);
    if (selected === 'claude') {
      const permission = await installClaudePermissions({ home, env, name, configDir, backup, writeJson: privateJson });
      if (permission.changed && !options.embedded) ui.line("  Allowed SupportPages Writer's tools in Claude Code; deleting or unpublishing an article still asks first.");
    }
    if (selected === 'codex' && !updatingCodex) await (dependencies.installCodex ?? installCodexIntegration)({ home, env, name, configDir, backup, ui, announcePermission: !options.embedded });
    ui.ok(`${selected === 'codex' ? 'Codex' : 'Claude Code'} connected as ${name}`);
  }
  if (!clients.length) ui.line(`  Add the server entry from ${manualPath} to your MCP client.\n${JSON.stringify(manual, null, 2)}`);
  if (!clients.length) await privateJson(receiptPath, receipt);
  await checked(process.execPath, [...serverArgs, '--help'], { capture: true });
  ui.ok('Server startup checked');
  if (options.embedded) return { name, clients: receipt.clients, manualPath, skillsDir: skills.directory };
  ui.line('\n  Setup complete.');
  ui.line('  Restart your coding client and open any product repository.');
  ui.line('  Try: “Initialize SupportPages.io for this project.”');
  ui.line('  Run supportpages setup once on this computer, then supportpages init inside each project folder.');
  return { name, clients: receipt.clients, manualPath, skillsDir: skills.directory };
}
