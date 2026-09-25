import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Bridge } from './bridge.js';
import { parse } from './artifacts.js';
import { contextSchema, remoteId, bindingSchema } from './schema.js';
import { fail } from './errors.js';

/** CLI-only, after the user confirms moving this folder to another help centre. The device credential is untouched. */
export async function replaceConnection(bridge: Bridge, expectedProjectId: string, projectId: string) {
  parse(remoteId, projectId);
  parse(remoteId, expectedProjectId);
  const context = parse(contextSchema, await bridge.api.request('GET', `/projects/${projectId}/context`), 'invalid_response');
  if (context.project.id !== projectId) fail('invalid_response', 'Project identity mismatch.');
  return bridge.lock(async () => {
    const previous = await bridge.binding();
    if (previous.project_id !== expectedProjectId) fail('destination_mismatch', 'The workspace connection changed during setup. Run supportpages init again to review it.');
    await bridge.runs.assertAvailable();
    if ((await bridge.setup.progress())?.status === 'running') fail('workspace_busy', 'Finish or stop project analysis before changing the connected help centre.');
    const root = bridge.stateRoot;
    const archive = `${root}/archives/project-${expectedProjectId}-${randomUUID()}`;
    const candidates: { root: string; time: number }[] = [];
    for (const entry of await bridge.ws.list(`${root}/archives`)) {
      if (!entry.isDirectory() || !entry.name.startsWith(`project-${projectId}-`)) continue;
      const saved = `${root}/archives/${entry.name}`;
      if (!await bridge.ws.exists(`${saved}/binding.json`)) continue;
      const identity = bindingSchema.safeParse(await bridge.ws.json(`${saved}/binding.json`));
      if (identity.success && identity.data.project_id === projectId && identity.data.api_origin === bridge.api.origin) {
        candidates.push({ root: saved, time: (await stat(await bridge.ws.resolve(saved))).mtimeMs });
      }
    }
    const restore = candidates.sort((a, b) => b.time - a.time)[0]?.root;
    // Detection and agent settings belong to the checkout. Its task directories
    // contain the summary/overview referenced by the accepted analysis receipt.
    // Working files already have project-specific paths; keep those paths stable
    // so archived runs can be restored and resumed without moving their artifacts.
    const entries = (await bridge.ws.list(root))
      .filter(entry => !['operation.lock', 'dev', 'archives', 'setup', 'work'].includes(entry.name)).map(entry => entry.name);
    entries.push(...(await bridge.ws.list(`${root}/setup`))
      .filter(entry => !['analysis.json', 'settings.json', 'tasks'].includes(entry.name)).map(entry => `setup/${entry.name}`));
    const moved: string[] = [];
    const restored: string[] = [];
    try {
      for (const entry of entries) {
        const destination = await bridge.ws.resolve(`${archive}/${entry}`);
        await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
        await rename(await bridge.ws.resolve(`${root}/${entry}`), destination);
        moved.push(entry);
      }
      if (restore) for (const entry of ['runs', 'articles', 'bundles', 'previews', 'active-run.json']) {
        if (!await bridge.ws.exists(`${restore}/${entry}`)) continue;
        await rename(await bridge.ws.resolve(`${restore}/${entry}`), await bridge.ws.resolve(`${root}/${entry}`));
        restored.push(entry);
      }
      await bridge.ws.writeJson(`${root}/binding.json`, { version: 1, api_origin: bridge.api.origin, project_id: projectId });
      return { archive, restored_history: restored.length > 0 };
    } catch (error) {
      for (const entry of restored.reverse()) await rename(await bridge.ws.resolve(`${root}/${entry}`), await bridge.ws.resolve(`${restore}/${entry}`));
      // Restore only entries actually moved, including the previous binding.
      for (const entry of moved.reverse()) {
        await rm(await bridge.ws.resolve(`${root}/${entry}`), { recursive: true, force: true });
        await rename(await bridge.ws.resolve(`${archive}/${entry}`), await bridge.ws.resolve(`${root}/${entry}`));
      }
      await rm(await bridge.ws.resolve(archive), { recursive: true, force: true });
      throw error;
    }
  });
}
