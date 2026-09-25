import path from 'node:path';
import { readFile } from 'node:fs/promises';

export const PLUGIN_NAME = 'supportpages-writer';

/** True when Claude Code has the SupportPages Writer plugin installed (any
 * marketplace, any scope). The plugin brings its own MCP server and writer
 * agent, so a separate registration would show every tool twice. */
export async function claudePluginInstalled({ home, env = {} }) {
  const file = path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'plugins', 'installed_plugins.json');
  try {
    const plugins = JSON.parse(await readFile(file, 'utf8')).plugins ?? {};
    return Object.entries(plugins).some(([id, installs]) => id.split('@')[0] === PLUGIN_NAME && Array.isArray(installs) && installs.length > 0);
  } catch { return false; }
}
