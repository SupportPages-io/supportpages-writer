import path from 'node:path';
import os from 'node:os';
import { installManagedWriter } from './managed-writer.mjs';

/** Update owned writer policies without adding integrations or changing permissions. */
export async function refreshWriters({ home = os.homedir(), env = process.env } = {}) {
  const { codexWriterFile, writerAgentFile, writerAgentType } = await import('../../dist/writer-agent.js');
  for (const entry of [
    { config: path.resolve(env.CODEX_HOME || path.join(home, '.codex')), extension: 'toml', contents: codexWriterFile, marker: '# Managed by SupportPages: article writer v1' },
    { config: path.resolve(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude')), extension: 'md', contents: writerAgentFile, marker: '<!-- Managed by SupportPages: article writer v1 -->' },
  ]) await installManagedWriter({ ...entry, name: writerAgentType, existingOnly: true });
}
