import { createHash, randomUUID } from 'node:crypto';
import { readFile, lstat, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Workspace } from '../../dist/workspace.js';
import { Runs } from '../../dist/runs.js';
import { fail } from '../../dist/errors.js';
import { Cancelled } from './terminal.mjs';

const stateRoot = '.rtfm/supportpages';
const retained = new Set(['operation.lock', 'archives']);
async function readProfile(filename) {
  try {
    if (!(await lstat(filename)).isFile()) fail('invalid_configuration', 'The workspace profile must be a regular file.');
    return await readFile(filename);
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/** Forget this folder's setup in every environment, without contacting an API. */
export async function uninitWorkspace(root, configDir, { ui, yes = false } = {}) {
  const ws = await Workspace.create(root);
  const profile = path.join(configDir, 'workspaces', createHash('sha256').update(ws.root).digest('hex') + '.json');
  const before = await readProfile(profile);
  const entries = async () => (await ws.list(stateRoot)).filter(entry => !retained.has(entry.name)).map(entry => entry.name).sort();
  const originalEntries = await entries();
  if (!before && !originalEntries.length) {
    ui.ok('This folder is already uninitialized. Run supportpages init to set it up.');
    return { status: 'uninitialized', already_uninitialized: true, workspace: ws.root };
  }
  ui.intro?.('SupportPages Writer · Forget project setup');
  ui.line(`Folder: ${ws.root.replace(/[\p{Cc}\p{Cf}]/gu, '')}`);
  ui.line('Forget this folder’s local, development and production setup, including its remembered API environment.');
  ui.line('Setup and recovery files will be archived. Exported articles, remote content, device sign-in and agent integrations are kept. Hosted jobs already submitted keep running.');
  if (!yes && !await ui.confirm('Forget setup for this folder?', false)) throw new Cancelled('Project setup was kept.');
  const result = await ws.lock(async () => {
    const current = await readProfile(profile);
    if (!((before === null && current === null) || before?.equals(current ?? Buffer.alloc(0))) ||
        JSON.stringify(await entries()) !== JSON.stringify(originalEntries)) {
      fail('configuration_changed', 'Project setup changed during review. Rerun supportpages uninit.');
    }
    await new Runs(ws, stateRoot).assertAvailable();
    const roots = [stateRoot, ...(await ws.list(`${stateRoot}/dev`)).filter(entry => entry.isDirectory()).map(entry => `${stateRoot}/dev/${entry.name}`)];
    for (const directory of roots) {
      const task = `${directory}/setup/task.json`;
      if (await ws.exists(task) && (await ws.json(task)).status === 'running') {
        fail('workspace_busy', 'Finish or stop project analysis before running supportpages uninit.');
      }
    }
    const archive = `${stateRoot}/archives/uninit-${randomUUID()}`;
    await ws.writeJson(`${archive}/recovery.json`, { version: 1, workspace: ws.root, profile, entries: originalEntries, created_at: new Date().toISOString() });
    if (before) await ws.write(`${archive}/workspace-profile.json`, before);
    const moved = [];
    try {
      for (const entry of originalEntries) {
        await rename(await ws.resolve(`${stateRoot}/${entry}`), await ws.resolve(`${archive}/${entry}`));
        moved.push(entry);
      }
      if (before) {
        if (!before.equals(await readProfile(profile) ?? Buffer.alloc(0))) fail('configuration_changed', 'The workspace environment changed. Rerun supportpages uninit.');
        await unlink(profile);
      }
    } catch (error) {
      for (const entry of moved.reverse()) await rename(await ws.resolve(`${archive}/${entry}`), await ws.resolve(`${stateRoot}/${entry}`));
      throw error;
    }
    return { status: 'uninitialized', workspace: ws.root, archive: await ws.resolve(archive) };
  });
  ui.ok('Project setup removed. Run supportpages init to choose where articles go.');
  ui.line(`Recovery files: ${result.archive}`);
  ui.line('Use --dev only when you want the development service. Restart existing agent sessions to refresh their connection state.');
  return result;
}
