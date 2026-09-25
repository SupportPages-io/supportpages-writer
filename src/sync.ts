import { z } from 'zod';
import { stat } from 'node:fs/promises';
import type { Bridge } from './bridge.js';
import { contextSchema, remoteArticleSchema, remoteId } from './schema.js';
import { parse, sha256 } from './artifacts.js';
import { runSchema } from './runs.js';
import { fail, publicError } from './errors.js';
import { Walkthroughs } from './walkthroughs.js';

const identity = { id: remoteId, local_article_id: z.uuid().nullable(), title: z.string(), section_id: remoteId.nullable() };
const generation = z.object({ run_id: z.uuid(), attempt: z.uuid(), state: z.enum(['running', 'failed', 'interrupted', 'cancelled', 'complete', 'kept', 'discarded']) });
const live = remoteArticleSchema.extend({ ...identity, deleted_at: z.null(), accepted_bundle_hash: z.string().nullable().optional(), generation: generation.nullable().optional() });
const tombstone = z.object({ ...identity, deleted_at: z.string().min(1) });
const pageSchema = z.object({ project_id: remoteId, through_id: z.string().regex(/^\d+$/),
  next_cursor: remoteId.nullable(), articles: z.array(z.union([live, tombstone])).max(500) });
const stateSchema = z.object({ project_id: remoteId.optional(), api_origin: z.url().optional(), local_article_id: z.uuid(), artifact_dir: z.string(), bundle_dir: z.string(),
  bundle_hash: z.string(), uploaded_bundle_hash: z.string().optional(), remote: remoteArticleSchema.optional() });
type Context = z.infer<typeof contextSchema>;
type Remote = z.infer<typeof pageSchema>['articles'][number];
type Local = { local_article_id: string; artifact_dir: string; title?: string; run_id?: string;
  phase?: string; baseline?: z.infer<typeof remoteArticleSchema>; changed: boolean; content_changed: boolean; bundle_hash?: string; generation_attempt?: string };

/** Observed remote state is separate from the revision an upload was based on. */
export class ProjectSync {
  constructor(private bridge: Bridge) {}
  async localRecords() {
    const { ws, stateRoot } = this.bridge, binding = await this.bridge.binding();
    const archives: { root: string; time: number }[] = [];
    for (const entry of await ws.list(`${stateRoot}/archives`)) {
      if (!entry.isDirectory()) continue;
      const root = `${stateRoot}/archives/${entry.name}`;
      if (!await ws.exists(`${root}/binding.json`)) continue;
      const archived = await ws.json(`${root}/binding.json`) as { project_id?: string; api_origin?: string };
      if (archived.project_id === binding.project_id && archived.api_origin === binding.api_origin) archives.push({ root, time: (await stat(await ws.resolve(root))).mtimeMs });
    }
    const roots = [stateRoot, ...archives.sort((a, b) => b.time - a.time).map(entry => entry.root)];
    const result = new Map<string, Local>();
    // Active records win over history; history is never copied to a new project.
    for (const root of roots) {
      const runs = new Map<string, z.infer<typeof runSchema>>();
      for (const entry of await ws.list(`${root}/runs`)) {
        if (!entry.isDirectory() || !z.uuid().safeParse(entry.name).success) continue;
        const parsed = runSchema.safeParse(await ws.json(`${root}/runs/${entry.name}/run.json`));
        if (!parsed.success) continue;
        const run = parsed.data;
        if (run.project_id !== binding.project_id || run.api_origin !== binding.api_origin) continue;
        const previous = runs.get(run.local_article_id);
        if (!previous || run.started_at > previous.started_at) runs.set(run.local_article_id, run);
      }
      const states = new Map<string, z.infer<typeof stateSchema>>();
      for (const entry of await ws.list(`${root}/articles`)) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const parsed = stateSchema.safeParse(await ws.json(`${root}/articles/${entry.name}`));
        if (parsed.success && (!parsed.data.project_id || parsed.data.project_id === binding.project_id && parsed.data.api_origin === binding.api_origin)) states.set(parsed.data.local_article_id, parsed.data);
      }
      for (const id of new Set([...runs.keys(), ...states.keys()])) {
        if (result.has(id)) continue;
        const run = runs.get(id), state = states.get(id);
        const artifact = run?.artifact_dir ?? state!.artifact_dir;
        let changed = run?.status === 'prepared' || !state || state.bundle_hash !== state.uploaded_bundle_hash;
        let contentChanged = !state;
        if (state) {
          const bundle = root !== stateRoot && state.bundle_dir.startsWith(`${stateRoot}/`)
            ? root + state.bundle_dir.slice(stateRoot.length) : state.bundle_dir;
          try {
            const manifest = await ws.json(`${bundle}/manifest.json`) as { article_sha256: string; images: { filename: string; sha256: string }[] };
            contentChanged = sha256(await ws.read(`${artifact}/article.json`)) !== manifest.article_sha256;
            for (const image of manifest.images) if (sha256(await ws.read(`${artifact}/${image.filename}`, 10 * 1024 * 1024)) !== image.sha256) contentChanged = true;
          } catch { contentChanged = true; }
        }
        changed ||= contentChanged;
        result.set(id, { local_article_id: id, artifact_dir: artifact, run_id: run?.id, title: run?.title,
          phase: run?.phase, baseline: run?.remote ?? run?.progress?.article ?? state?.remote, changed, content_changed: contentChanged, bundle_hash: state?.bundle_hash, generation_attempt: run?.progress?.attempt });
      }
    }
    return [...result.values()];
  }
  // Caller holds the workspace lock. Commit only a complete, validated inventory.
  async refresh(context?: Context, includeWalkthroughs = true) {
    const binding = await this.bridge.binding();
    try { context ??= await this.bridge.context(); }
    catch (error) {
      if (['not_found', 'permission_denied'].includes(publicError(error).code)) fail('project_unavailable', 'This help centre is unavailable to the current account. Restore access or run supportpages init to choose a project. The existing link and last sync have been kept.');
      throw error;
    }
    if (context.project.id !== binding.project_id) fail('destination_mismatch', 'The project changed during sync. Run sync again.');
    if (!context.article_sync) return { status: 'unsupported' as const, project: context.project,
      instructions: 'Update the SupportPages.io server to sync article metadata. Existing upload revision checks still apply.' };
    const remote: Remote[] = [], seen = new Set<string>();
    let cursor: string | null = null, through: string | undefined;
    for (;;) {
      const query: string = cursor ? `?after_id=${cursor}&through_id=${through}` : '';
      const page: z.infer<typeof pageSchema> = parse(pageSchema, await this.bridge.api.request('GET', `/projects/${binding.project_id}/sync${query}`), 'invalid_response');
      if (page.project_id !== binding.project_id || through !== undefined && page.through_id !== through) fail('invalid_response', 'The sync response changed project or inventory boundaries.');
      through = page.through_id;
      for (const article of page.articles) {
        if (seen.has(article.id) || BigInt(article.id) <= BigInt(cursor ?? '0') || BigInt(article.id) > BigInt(page.through_id)) fail('invalid_response', 'Invalid article sync page.');
        seen.add(article.id); remote.push(article);
      }
      if (!page.next_cursor) break;
      if (page.next_cursor !== page.articles.at(-1)?.id || BigInt(page.next_cursor) <= BigInt(cursor ?? '0')) fail('invalid_response', 'Invalid article sync cursor.');
      cursor = page.next_cursor;
      if (remote.length > 100_000) fail('inventory_truncated', 'The article inventory is too large to sync. Previous sync records have been kept.');
    }
    const locals = await this.localRecords(), matched = new Set<string>();
    const byId = new Map(remote.map(article => [article.id, article]));
    const byLocalId = new Map<string, Remote>();
    for (const article of remote) if (article.local_article_id) {
      if (byLocalId.has(article.local_article_id)) fail('invalid_response', 'Multiple remote articles claim the same local identity.');
      byLocalId.set(article.local_article_id, article);
    }
    const articles = locals.map(local => {
      const article = local.baseline ? byId.get(local.baseline.id) : byLocalId.get(local.local_article_id);
      // A record that already links to a remote article by id keeps that link even
      // when the server remembers a different local identity for it (an earlier
      // attempt, or a record rewritten by a later run). The local record wins; the
      // mismatch is reported instead of aborting the whole sync.
      const identity_mismatch = Boolean(article && article.local_article_id && article.local_article_id !== local.local_article_id);
      if (article) matched.add(article.id);
      const available = article && article.deleted_at === null ? article as z.infer<typeof live> : undefined;
      const accepted = available?.accepted_bundle_hash && available.accepted_bundle_hash === local.bundle_hash;
      // A preview still locked to this exact writer can advance after a lost
      // milestone response. The server forbids editor changes until it is kept.
      const ownPreview = available?.generation?.run_id === local.run_id && available?.generation?.attempt === local.generation_attempt &&
        ['running', 'failed', 'interrupted', 'cancelled'].includes(available?.generation?.state ?? '');
      const changed = available && local.baseline && available.revision !== local.baseline.revision && !accepted && !ownPreview;
      const sync_status = article?.deleted_at ? 'deleted_remotely' : !article ? local.baseline ? 'unavailable' : 'local_only'
        : changed ? local.changed ? 'conflict' : 'remote_changed' : local.changed && (!accepted || local.content_changed) ? 'local_changes' : 'synced';
      return { ...local, remote: article, sync_status, ...(identity_mismatch ? { identity_mismatch } : {}) };
    });
    const remoteOnly = remote.filter(article => !matched.has(article.id) && article.deleted_at === null)
      .map(article => ({ remote: article, sync_status: 'remote_only' as const }));
    const previous = await this.bridge.ws.exists(`${this.bridge.stateRoot}/sync.json`)
      ? await this.bridge.ws.json(`${this.bridge.stateRoot}/sync.json`) as { walkthroughs?: Awaited<ReturnType<Walkthroughs['refresh']>> } : undefined;
    const walkthroughs = includeWalkthroughs ? await new Walkthroughs(this.bridge).refresh(context, previous?.walkthroughs) : previous?.walkthroughs;
    const result = { version: 1, status: 'ready' as const, project: context.project, api_origin: binding.api_origin,
      walkthroughs,
      synced_at: new Date().toISOString(), product_context: context.product_context, writing_style: context.writing_style,
      articles: [...articles, ...remoteOnly], counts: { local: locals.length, remote: remote.filter(article => !article.deleted_at).length,
        conflicts: articles.filter(article => article.sync_status === 'conflict').length,
        deleted: articles.filter(article => article.sync_status === 'deleted_remotely').length },
      instructions: 'Remote settings and article metadata are current. Local content is preserved. Review remote edits in the editor before updating an article; never recreate a remotely deleted article automatically.' };
    await this.bridge.ws.writeJson(`${this.bridge.stateRoot}/sync.json`, result);
    return result;
  }
  async guard(localId: string, context?: Context) {
    const result = await this.refresh(context, false);
    if (result.status !== 'ready') return result;
    const item = result.articles.find(item => 'local_article_id' in item && item.local_article_id === localId);
    if (!item) return result;
    const editor_url = item.remote && 'editor_url' in item.remote ? item.remote.editor_url : undefined;
    if (item.remote && 'generation' in item.remote && item.remote.generation?.state === 'kept') fail('run_closed', 'This preview was kept as an editable draft. Continue in the editor; its writer cannot resume or replace it.', { editor_url });
    if (item.sync_status === 'deleted_remotely') fail('article_deleted', 'This article was deleted in SupportPages.io. Restore it there before continuing; it will not be recreated automatically.', { editor_url });
    if (item.sync_status === 'unavailable') fail('article_unavailable', 'The linked article is unavailable. Check its project and access before continuing.');
    if (['conflict', 'remote_changed'].includes(item.sync_status)) fail('revision_conflict', 'This article changed in SupportPages.io. Review the current version in the editor before uploading local changes.', { editor_url });
    return result;
  }
}
