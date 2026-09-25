import path from 'node:path';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { autoUpdateEnabled, installationRoot } from '../../dist/runtime.js';
import { releaseInstallation, updateCli } from './update.mjs';
import { privateJson } from './install.mjs';

export const CHECK_INTERVAL = 24 * 60 * 60 * 1000;

/** An installation-wide lock plus a persisted attempt time prevents every agent
 * session checking separately. Failed checks are throttled too; manual updates
 * don't consult this state. Only the installer promotes a verified release.
 */
export async function automaticUpdate({ installRoot, env = process.env, now = Date.now, update = updateCli }) {
  if (!autoUpdateEnabled(env)) return;
  const root = installationRoot(installRoot);
  if (!root) return;
  const updateEnv = { ...env, SUPPORTPAGES_CLI_HOME: path.join(root, 'current') };
  const lock = path.join(root, '.auto-update.lock');
  const recovery = path.join(root, '.auto-update-recovery.lock');
  const state = path.join(root, 'auto-update.json');
  let locked = false;
  try {
    // An old server still running after an update cannot update on its behalf.
    await releaseInstallation(installRoot, updateEnv);
    try { await mkdir(lock, { mode: 0o700 }); }
    catch (error) {
      if (error.code !== 'EEXIST') return;
      // Recover an abandoned worker lock on a later day. Installer downloads
      // are time-bounded, so an attempt can never normally hold it this long.
      if (now() - (await stat(lock)).mtimeMs < CHECK_INTERVAL) return;
      // Serialize recovery and recheck: another worker may already have
      // replaced the stale lock with a live one while we were waiting.
      try { await mkdir(recovery, { mode: 0o700 }); } catch { return; }
      try {
        if (now() - (await stat(lock)).mtimeMs < CHECK_INTERVAL) return;
        await rm(lock, { recursive: true });
        await mkdir(lock, { mode: 0o700 });
      } finally { await rm(recovery, { recursive: true, force: true }); }
    }
    locked = true;
    let previous;
    try { previous = JSON.parse(await readFile(state, 'utf8')).checked_at; }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) return; }
    const checkedAt = now();
    if (Number.isFinite(previous) && checkedAt >= previous && checkedAt - previous < CHECK_INTERVAL) return;
    await privateJson(state, { version: 1, checked_at: checkedAt });
    await update({ installRoot, env: updateEnv, checkTimeout: 5, ui: { line() {} } });
  } catch { /* Offline, read-only, unavailable and invalid releases are silent. */ }
  finally { if (locked) await rm(lock, { recursive: true, force: true }).catch(() => {}); }
}
