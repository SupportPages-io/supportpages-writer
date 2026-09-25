import path from 'node:path';
import os from 'node:os';
import { installManagedWriter } from './managed-writer.mjs';

/** Install the personal agent so Claude launched outside our CLI can discover it. */
export async function installClaudeWriter({ home = os.homedir(), env = process.env } = {}) {
  const { writerAgentFile, writerAgentType } = await import('../../dist/writer-agent.js');
  return installManagedWriter({ config: path.resolve(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude')),
    name: writerAgentType, extension: 'md', contents: writerAgentFile, marker: '<!-- Managed by SupportPages: article writer v1 -->' });
}
