import { execFile } from 'node:child_process';
import { z } from 'zod';
import type { Bridge } from './bridge.js';
import { articleSchema, manifestSchema, remoteArticleSchema } from './schema.js';
import { createManifest, parse, sha256, progressSnapshot } from './artifacts.js';
import { exportArticle } from './export.js';
import type { Run } from './runs.js';
import path from 'node:path';
import { fail, publicError } from './errors.js';

export const progressResponse = z.object({ run_id: z.uuid(), attempt: z.uuid(), state: z.enum(['running', 'failed', 'interrupted', 'cancelled', 'complete', 'kept', 'discarded']), sequence: z.number().int().nonnegative(), article: remoteArticleSchema });
export async function openPreview(url: string): Promise<boolean> {
  const env = { ...process.env };
  delete env.SUPPORTPAGES_API_TOKEN;
  delete env.SUPPORTPAGES_API_TOKEN_FILE;
  if (!['darwin', 'linux'].includes(process.platform)) return false;
  return new Promise(resolve => execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { env, timeout: 5000 }, error => resolve(!error)));
}

/** Session-owned relay. The host writer only writes artifacts, never credentials. */
export class ProgressRelay {
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private failures = 0;
  private generation = 0;
  constructor(private bridge: Bridge, private open = openPreview) {}
  stop() { this.running = false; this.generation++; clearTimeout(this.timer); }
  start(id: string) {
    this.stop(); this.running = true; this.failures = 0;
    this.schedule(id, 0);
  }
  private schedule(id: string, delay: number) {
    if (!this.running) return;
    const generation = this.generation;
    this.timer = setTimeout(async () => {
      try { await this.tick(id, true, generation); if (generation === this.generation) this.failures = 0; }
      catch (error) {
        if (generation !== this.generation) return;
        this.failures++;
        const safe = publicError(error);
        await this.bridge.lock(async () => {
          if (generation !== this.generation) return;
          const run = await this.bridge.runs.read(id);
          if (run.progress) await this.bridge.runs.save({ ...run, progress: { ...run.progress, sync_error: safe.message, sync_failures: (run.progress.sync_failures ?? 0) + 1 } });
        }).catch(() => {});
        if (generation === this.generation && !['network_error', 'remote_error', 'rate_limited', 'workspace_busy'].includes(safe.code)) this.stop();
      }
      if (generation !== this.generation) return;
      this.schedule(id, this.failures ? Math.min(60_000, 2000 * 2 ** this.failures) : 2000);
    }, delay);
    this.timer.unref();
  }
  async ensureStartedUnlocked(id: string) {
    let run = await this.bridge.runs.read(id);
    if (!run.progress || run.progress.article) return run;
    let result: z.infer<typeof progressResponse>;
    try {
      result = parse(progressResponse, await this.bridge.api.request('POST', `/projects/${run.project_id}/generation_runs`, {
        run_id: run.id, local_article_id: run.local_article_id, attempt: run.progress.attempt,
        title: run.title, article_type: run.article_type ?? 'how-to', section_id: run.section_id,
      }), 'invalid_response');
    } catch (error) {
      await this.bridge.runs.save({ ...run, progress: { ...run.progress, sync_error: publicError(error).message } });
      throw error;
    }
    run = { ...run, progress: { ...run.progress, article: result.article, last_heartbeat: Date.now(), sync_error: undefined } };
    await this.bridge.runs.save(run);
    if (result.state !== 'running') fail('run_closed', 'This preview is closed. Use retry_article after stopping the writer.');
    return run;
  }
  async tick(id: string, scheduled = false, generation = this.generation) {
    if (scheduled) {
      if (!this.running || generation !== this.generation) return;
      const observed = await this.bridge.runs.read(id);
      // Shutdown may finish while this read is in flight. Do not enqueue a new
      // workspace operation after close() has drained the existing queue.
      if (!this.running || generation !== this.generation) return;
      // Watching for an explicit finish must not compete with unrelated
      // workspace operations while no preview work or finish request exists.
      // Recheck every condition under the lock when there is work to perform.
      if (!observed.writer_completed_at && ((!observed.progress && observed.project_id) || observed.phase === 'prepared')) return;
    }
    const complete = await this.bridge.lock(async () => {
      if (scheduled && (!this.running || generation !== this.generation)) return;
      let run = await this.bridge.runs.read(id);
      if (run.writer_completed_at && !run.remote && !run.error && run.phase !== 'saved' && ['prepared', 'finalized'].includes(run.status)) return true;
      if (run.status !== 'prepared') { this.stop(); return; }
      // Preparation arms observation; only actual writer entry (or the host's
      // explicit started event) enables heartbeats and preview uploads.
      if (run.phase === 'prepared') return;
      if (run.phase !== 'writing') { this.stop(); return; }
      if (!run.project_id) { await this.exportLocalUnlocked(run); return; }
      if (!run.progress) return;
      run = await this.ensureStartedUnlocked(id);
      let progress = run.progress!;
      const route = `/projects/${run.project_id}/generation_runs/${run.id}`;
      if (Date.now() - (progress.last_heartbeat ?? 0) >= 30_000) {
        const response = parse(progressResponse, await this.bridge.api.request('POST', `${route}/event`, { event: 'heartbeat', attempt: progress.attempt }), 'invalid_response');
        progress = { ...progress, article: response.article, last_heartbeat: Date.now(), sync_error: undefined };
        run = { ...run, progress };
        await this.bridge.runs.save(run);
      }
      if (progress.pending) { await this.sendPendingUnlocked(id); return; }
      const snap = await progressSnapshot(this.bridge.ws, run.artifact_dir, { imageHashes: progress.image_hashes });
      if (!snap) return;
      const articleHash = sha256(snap.articleBytes);
      if (articleHash === progress.article_hash && !snap.images.length) return;
      const manifest = createManifest(snap, { local_article_id: run.local_article_id, run_id: run.id, skills_version: run.skills_version, source_commit: null, source_dirty: true, section_id: run.section_id });
      // Persist the exact request before sending: a lost response must retry the
      // same sequence and bytes, even when the writer has produced newer files.
      const pending = progress.pending ?? { sequence: progress.sequence + 1, directory: `${this.bridge.stateRoot}/runs/${run.id}/progress-pending` };
      if (!progress.pending) {
        await this.bridge.ws.writeJson(`${pending.directory}/manifest.json`, manifest);
        await this.bridge.ws.write(`${pending.directory}/article.json`, snap.articleBytes);
        for (const image of snap.images) await this.bridge.ws.write(`${pending.directory}/${image.filename}`, image.bytes);
        progress = { ...progress, pending };
        await this.bridge.runs.save({ ...run, progress });
      }
      await this.sendPendingUnlocked(id);
    });
    // Reuse final validation/import outside the operation lock. Only an explicit
    // successful writer finish can reach here; files or silence alone never do.
    // Delivery copy is left for the parent's complete_article call, so the relay
    // does not consume the one-time invitation or publication question.
    if (complete && (!scheduled || (this.running && generation === this.generation))) {
      await this.bridge.complete({ run_id: id, completed: true }, { deliver: false });
    }
  }
  private async exportLocalUnlocked(run: Run) {
    if (await this.bridge.destination() !== 'local') fail('destination_mismatch', 'This local writer no longer belongs to the current destination.');
    const local = await this.bridge.local();
    if (!local) fail('local_required', 'Local article settings are missing.');
    const directory = run.local_export?.directory ?? local.export_dir;
    const slug = run.artifact_dir.split('/').at(-1)!;
    try {
      const snap = await progressSnapshot(this.bridge.ws, run.artifact_dir, {
        fallbackDir: path.posix.join(directory, slug),
      });
      if (!snap) return;
      const exported = await exportArticle(this.bridge.ws, snap, run.artifact_dir, directory, slug);
      if (run.local_export?.markdown_path !== exported.markdown_path || run.local_export?.sync_error) {
        await this.bridge.runs.save({ ...run, local_export: { directory, markdown_path: exported.markdown_path } });
      }
    } catch (error) {
      // Keep writing and retry the export on the next observation. Preview
      // delivery errors do not mean that generation itself has failed.
      await this.bridge.runs.save({ ...run, local_export: { ...run.local_export, directory, sync_error: publicError(error).message } });
    }
  }
  async sendPendingUnlocked(id: string) {
    const run = await this.bridge.runs.read(id);
    const progress = run.progress!;
    if (!progress.pending) return;
    const { directory, sequence } = progress.pending;
    const manifest = parse(manifestSchema, await this.bridge.ws.json(`${directory}/manifest.json`));
    const form = new FormData();
    form.set('attempt', progress.attempt); form.set('sequence', String(sequence));
    form.set('manifest', JSON.stringify(manifest));
    form.set('article', new Blob([new Uint8Array(await this.bridge.ws.read(`${directory}/article.json`))]), 'article.json');
    for (const image of manifest.images) form.set(`images[${image.block_id}]`, new Blob([new Uint8Array(await this.bridge.ws.read(`${directory}/${image.filename}`, 10 * 1024 * 1024))], { type: 'image/png' }), image.filename);
    const response = parse(progressResponse, await this.bridge.api.request('POST', `/projects/${run.project_id}/generation_runs/${id}/milestones`, form, manifest.bundle_hash), 'invalid_response');
    const article = parse(articleSchema, JSON.parse((await this.bridge.ws.read(`${directory}/article.json`)).toString()));
    const ids = new Set(article.blocks.filter(b => b.type === 'section' && b.has_image).map(b => b.id));
    const hashes = Object.fromEntries(Object.entries(progress.image_hashes ?? {}).filter(([key]) => ids.has(key)));
    for (const image of manifest.images) hashes[image.block_id] = image.sha256;
    const shouldOpen = run.open_when_ready && !progress.open_attempted;
    await this.bridge.runs.save({ ...run, progress: { ...progress, article: response.article, sequence: response.sequence,
      pending: undefined, article_hash: manifest.article_sha256, image_hashes: hashes, last_heartbeat: Date.now(), sync_error: undefined,
      open_attempted: progress.open_attempted || Boolean(shouldOpen) } });
    if (shouldOpen) {
      const opened = await this.open(response.article.editor_url).catch(() => false);
      const current = await this.bridge.runs.read(id);
      await this.bridge.runs.save({ ...current, progress: { ...current.progress!, browser_opened: opened } });
    }
  }
}
