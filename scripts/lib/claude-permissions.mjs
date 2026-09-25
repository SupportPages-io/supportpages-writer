import path from 'node:path';
import { lstat, readFile } from 'node:fs/promises';

/** Tools that remove content from a help centre: always confirmed, even when the rest are allowed. */
export const askFirstTools = ['supportpages_delete_article', 'supportpages_unpublish_article'];

/** The rules setup adds for a registered MCP connection: every tool on it allowed, removals asked. */
export const claudePermissionRules = name => ({
  allow: [`mcp__${name}`],
  ask: askFirstTools.map(tool => `mcp__${name}__${tool}`),
});

/**
 * Allow the SupportPages tools on the successfully registered MCP connection, so
 * uploads and edits the user asked for are not blocked in auto mode. Deleting and
 * unpublishing stay on ask. Existing rules are kept: Claude Code applies deny, then
 * ask, then allow, so any restriction the user added still wins.
 */
export async function installClaudePermissions({ home, env = process.env, name, configDir, backup, writeJson }) {
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(name)) throw Error('Invalid SupportPages.io connection name.');
  const directory = path.resolve(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'));
  const filename = path.join(directory, 'settings.json');
  for (const entry of [directory, filename]) {
    try {
      const info = await lstat(entry);
      if (info.isSymbolicLink() || (entry === filename ? !info.isFile() : !info.isDirectory())) throw Error(`Cannot update Claude permissions at an unsafe path: ${entry}`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  let settings;
  try { settings = JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; settings = {}; }
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!object(settings) || (settings.permissions !== undefined && !object(settings.permissions))) throw Error('Claude Code permission settings are invalid. Repair settings.json before installing.');
  const permissions = settings.permissions ?? {};
  for (const key of ['allow', 'ask', 'deny']) {
    if (permissions[key] !== undefined && (!Array.isArray(permissions[key]) || permissions[key].some(rule => typeof rule !== 'string'))) throw Error('Claude Code permission rules are invalid. Repair settings.json before installing.');
  }
  const rules = claudePermissionRules(name);
  const missing = key => rules[key].filter(rule => !permissions[key]?.includes(rule));
  const allow = missing('allow'), ask = missing('ask');
  if (!allow.length && !ask.length) return { filename, rules, changed: false };
  await backup(filename, path.join(configDir, 'backups'));
  await writeJson(filename, { ...settings, permissions: { ...permissions,
    ...(allow.length ? { allow: [...(permissions.allow ?? []), ...allow] } : {}),
    ...(ask.length ? { ask: [...(permissions.ask ?? []), ...ask] } : {}) } });
  return { filename, rules, changed: true };
}
