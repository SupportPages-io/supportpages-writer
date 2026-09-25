import path from 'node:path';
import { access, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';

/** Only the managed versions/<release>/mcp layout can update itself. */
export function installationRoot(installRoot: string): string | undefined {
  const version = path.dirname(installRoot);
  if (path.basename(installRoot) !== 'mcp' || path.basename(path.dirname(version)) !== 'versions') return;
  return path.dirname(path.dirname(version));
}

export function autoUpdateEnabled(env: NodeJS.ProcessEnv): boolean {
  return !['0', 'false', 'off'].includes((env.SUPPORTPAGES_AUTO_UPDATE ?? '').toLowerCase()) &&
    (!env.CI || ['0', 'false'].includes(env.CI.toLowerCase()));
}

/** Keep this session's engine on the same immutable release as its JS modules.
 * Older installers registered the bundled skills by an absolute version path,
 * first as mcp/skills and now as mcp/engine; both map to this release's engine.
 * External engine checkouts remain exactly the user's choice.
 */
export async function pinSkills(installRoot: string, skillsDir: string): Promise<string> {
  const root = installationRoot(installRoot);
  if (root) {
    const relative = path.relative(root, skillsDir).split(path.sep);
    const bundledName = (name: string | undefined) => name === 'skills' || name === 'engine';
    // Skills copies that earlier setups kept in the shared data directory
    // (<data>/skills/<name>, beside <data>/cli) are managed too.
    const shared = path.relative(path.join(path.dirname(root), 'skills'), skillsDir).split(path.sep);
    const bundled = (relative.length === 3 && relative[0] === 'current' && relative[1] === 'mcp' && bundledName(relative[2])) ||
      (relative.length === 4 && relative[0] === 'versions' && relative[2] === 'mcp' && bundledName(relative[3])) ||
      (shared.length === 1 && shared[0] !== '' && shared[0] !== '..');
    if (bundled) {
      const candidate = path.join(installRoot, 'engine');
      try {
        await access(path.join(candidate, 'generate-illustrated-article', 'SKILL.md'));
        skillsDir = candidate;
      } catch { /* An older release without an engine keeps its registered skills. */ }
    }
  }
  return realpath(skillsDir).catch(() => skillsDir);
}

/** No inherited protocol streams, no waiting, and no prompts in an agent session. */
export function startBackgroundUpdate(installRoot: string, env = process.env, spawnProcess = spawn): void {
  if (!autoUpdateEnabled(env) || !installationRoot(installRoot)) return;
  const safeEnv = { ...env };
  delete safeEnv.SUPPORTPAGES_API_TOKEN;
  delete safeEnv.SUPPORTPAGES_API_TOKEN_FILE;
  try {
    const child = spawnProcess(process.execPath, [path.join(installRoot, 'scripts/auto-update.mjs')], {
      cwd: installRoot, env: safeEnv, detached: true, stdio: 'ignore',
    });
    child.on('error', () => {});
    child.unref();
  } catch { /* Updating must never prevent a connection. */ }
}
