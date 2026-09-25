import path from 'node:path';
import os from 'node:os';
import { lstat, readFile } from 'node:fs/promises';
import { installManagedFile } from './managed-writer.mjs';

const marker = '<!-- Managed by SupportPages: article coordination v1 -->';
const configPath = (home, env) => path.resolve(env.CODEX_HOME || path.join(home, '.codex'));

export async function installCodexSkill({ home = os.homedir(), env = process.env } = {}) {
  return installManagedFile({ config: configPath(home, env), parts: ['skills', 'supportpages', 'SKILL.md'],
    contents: await readFile(new URL('../skills/supportpages/SKILL.md', import.meta.url), 'utf8'), marker, kind: 'skill' });
}

/** Upgrades only add the skill to a previously managed Codex integration. */
export async function refreshCodexSkill({ home = os.homedir(), env = process.env } = {}) {
  const config = configPath(home, env);
  for (const [parts, ownership] of [
    [['agents', 'supportpages-io.toml'], '# Managed by SupportPages: article writer v1'],
    [['skills', 'supportpages', 'SKILL.md'], marker],
  ]) {
    let entry = config;
    try {
      for (const part of ['', ...parts]) {
        entry = path.join(entry, part);
        const info = await lstat(entry);
        if (info.isSymbolicLink() || (entry === path.join(config, ...parts) ? !info.isFile() : !info.isDirectory())) {
          throw Error(`Cannot refresh the SupportPages.io skill from an unsafe path: ${entry}`);
        }
      }
      if ((await readFile(entry, 'utf8')).includes(ownership)) return installCodexSkill({ home, env });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { changed: false };
}
