import path from 'node:path';
import os from 'node:os';
import { lstat, readFile } from 'node:fs/promises';
import { backup, privateJson } from './install.mjs';

/** Match Claude's /mcp project toggle without removing global registrations. */
export async function selectClaudeConnection({ workspace, dev, configDir, home = os.homedir(), env = process.env }) {
  const filename = env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(home, '.claude.json');
  for (const entry of [path.dirname(filename), filename]) {
    try { if ((await lstat(entry)).isSymbolicLink()) throw Error('Cannot update a linked Claude configuration.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  let contents;
  try { contents = await readFile(filename, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const config = contents === undefined ? {} : JSON.parse(contents);
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!object(config) || (config.projects !== undefined && !object(config.projects))) throw Error('Claude project settings are invalid.');
  const root = path.resolve(workspace);
  const project = config.projects?.[root] ?? {};
  if (!object(project) || (project.disabledMcpServers !== undefined && (!Array.isArray(project.disabledMcpServers) || project.disabledMcpServers.some(name => typeof name !== 'string')))) throw Error('Claude MCP choices are invalid.');
  const selected = dev ? 'supportpages-dev' : 'supportpages';
  const other = dev ? 'supportpages' : 'supportpages-dev';
  const disabled = [...new Set([...(project.disabledMcpServers ?? []).filter(name => name !== selected), other])];
  if (JSON.stringify(disabled) === JSON.stringify(project.disabledMcpServers)) return false;
  await backup(filename, path.join(configDir, 'backups'));
  let current;
  try { current = await readFile(filename, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (current !== contents) throw Error('Claude configuration changed. Rerun supportpages init to retry.');
  await privateJson(filename, { ...config, projects: { ...config.projects, [root]: { ...project, disabledMcpServers: disabled } } });
  return true;
}
