import path from 'node:path';
import { readFile, readlink, realpath, rm } from 'node:fs/promises';

export const ARTICLE_SKILLS = ['detect-project', 'generate-illustrated-article'];
const retired = ['suggest-sections', 'recommend-articles', 'recommend-walkthroughs', 'generate-walkthrough', 'generate-card-backgrounds'];

export async function retirePublicSkillLinks({ home, clients, directory, previousDirectory, env = {}, dryRun = false }) {
  const canonical = async value => {
    try { return await realpath(value); } catch (error) { if (error.code === 'ENOENT') return path.resolve(value); throw error; }
  };
  const roots = await Promise.all([directory, previousDirectory].filter(Boolean).map(canonical));
  const anchor = path.join(home, '.rtfm-skills');
  // Older receipts omitted skills_dir, and MCP may now point at a worktree.
  // The managed engine shortcut still identifies those earlier public links.
  try { roots.push(await canonical(path.resolve(home, await readlink(anchor))), anchor); }
  catch (error) { if (!['ENOENT', 'EINVAL'].includes(error.code)) throw error; }
  const removed = [];
  const discoveries = new Set(clients.flatMap(selected => selected === 'claude'
    ? [path.join(home, '.claude/skills'), path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'skills')]
    : [path.join(home, '.agents/skills'), path.join(home, '.codex/skills'), path.join(env.CODEX_HOME || path.join(home, '.codex'), 'skills')]));
  for (const discovery of discoveries) {
    for (const name of [...ARTICLE_SKILLS, ...retired]) {
      const filename = path.join(discovery, name);
      try {
        const linked = path.resolve(discovery, await readlink(filename));
        const targets = [await canonical(linked), path.join(await canonical(path.dirname(linked)), path.basename(linked))];
        if (roots.some(root => targets.includes(path.join(root, name)))) removed.push(filename);
      } catch (error) { if (!['ENOENT', 'EINVAL'].includes(error.code)) throw error; }
    }
  }
  // Discover all ownership first: some clients link through another discovery directory.
  if (!dryRun) for (const filename of removed) await rm(filename);
  return removed;
}

/** Earlier releases linked ~/.rtfm-skills at the managed skills copy. Remove that
 * link when it points into SupportPages Writer's own data directory; a link to
 * a separate skills checkout belongs to that checkout and is left alone. */
export async function retireManagedAnchor({ home, dataDir }) {
  const anchor = path.join(home, '.rtfm-skills');
  let target;
  try { target = path.resolve(home, await readlink(anchor)); }
  catch (error) { if (['ENOENT', 'EINVAL'].includes(error.code)) return false; throw error; }
  const within = (root, file) => { const relative = path.relative(root, file); return relative && !relative.startsWith('..') && !path.isAbsolute(relative); };
  const roots = [path.resolve(dataDir)];
  try { roots.push(await realpath(dataDir)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!roots.some(root => within(root, target))) return false;
  await rm(anchor);
  return true;
}

const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";

/** Register the engine's trace hook with Claude Code, replacing earlier trace hooks. */
export async function installTraceHook({ home, env, writeJson, hookCommand }) {
  const filename = path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'settings.json');
  let settings;
  try { settings = JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; settings = {}; }
  const groups = settings.hooks?.PostToolUse ?? [];
  if (!Array.isArray(groups) || groups.some(group => !Array.isArray(group.hooks))) throw Error('Claude Code PostToolUse settings are invalid. Repair them before installing the article trace hook.');
  // The engine hook is Node; running it with the installation's own node keeps
  // it working where Node is not on the user's PATH.
  const command = hookCommand.map(shellQuote).join(' ');
  settings.hooks = { ...settings.hooks, PostToolUse: [
    ...groups.map(group => ({ ...group, hooks: group.hooks.filter(hook => !/trace_hook\.(sh|js)/.test(String(hook.command ?? ''))) })).filter(group => group.hooks.length),
    { matcher: '*', hooks: [{ type: 'command', command }] },
  ] };
  await writeJson(filename, settings);
}

/** Connect the bundled article engine to the chosen clients. The engine's
 * dependencies live in the package's own node_modules, so nothing is installed
 * into the skill folders and no skills are exposed to public discovery. */
export async function installArticleSkills({ home, client, directory, previousDirectory, writeJson, env = {}, dataDir, hookCommand }) {
  const clients = client === 'both' ? ['claude', 'codex'] : [client === 'manual' ? 'codex' : client];
  // Retire links before the anchor, so previous installations remain identifiable.
  const removed = await retirePublicSkillLinks({ home, clients, directory, previousDirectory, env });
  if (dataDir) await retireManagedAnchor({ home, dataDir });
  if (clients.includes('claude') && hookCommand) await installTraceHook({ home, env, writeJson, hookCommand });
  return removed;
}
