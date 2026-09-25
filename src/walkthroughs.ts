import { z } from 'zod';
import type { Bridge } from './bridge.js';
import { contextSchema, remoteId } from './schema.js';
import { parse } from './artifacts.js';
import { fail } from './errors.js';
import { requireExecution, resolveAction } from './actions.js';

export const walkthroughSchema = z.object({
  id: remoteId, project_id: remoteId, article_id: remoteId, title: z.string(), slug: z.string(),
  revision: z.string().regex(/^[a-f0-9]{64}$/), generation_status: z.enum(['pending', 'running', 'completed', 'failed']),
  ready: z.boolean(), narrated: z.boolean(), publication_pending: z.boolean(), shared: z.boolean(), public_on_article: z.boolean(),
  review_url: z.url(), playback_url: z.url().nullable(), public_url: z.url().nullable(), article_public_url: z.url().nullable(),
  assets: z.object({ video: z.boolean(), narrated_video: z.boolean(), subtitles: z.boolean(), transcript: z.boolean(), poster: z.boolean() }),
  created_at: z.iso.datetime(), updated_at: z.iso.datetime(), generated_at: z.iso.datetime().nullable(), shared_at: z.iso.datetime().nullable(),
  error: z.object({ code: z.string(), message: z.string().max(500) }).nullable(),
  transcript_text: z.string().max(200_000).nullable().optional(), transcript_omitted: z.boolean().optional(),
});
const pageSchema = z.object({ project_id: remoteId, through_id: z.string().regex(/^\d+$/), next_cursor: remoteId.nullable(), walkthroughs: z.array(walkthroughSchema).max(500) });
const snapshotSchema = z.object({ project_id: remoteId, api_origin: z.url(), items: z.array(z.object({
  id: remoteId, remote: walkthroughSchema.nullable(), last_known: walkthroughSchema.optional(),
  sync_status: z.enum(['remote_only', 'synced', 'remote_changed', 'unavailable']),
})) });
type Context = z.infer<typeof contextSchema>;

export class Walkthroughs {
  constructor(private bridge: Bridge) {}

  private async supported() {
    // Article and walkthrough inspection share the existing read permission.
    // The additive context flag lets older clients keep their action contract.
    requireExecution(await resolveAction(this.bridge, 'read_articles'), 'remote');
    const context = await this.bridge.context();
    if (!context.walkthrough_sync) fail('server_update_required', 'Update the SupportPages server to inspect video walkthroughs.');
    return context;
  }

  private check(item: z.infer<typeof walkthroughSchema>, project: string) {
    if (item.project_id !== project) fail('invalid_response', 'The server returned a walkthrough from another project.');
    for (const value of [item.review_url, item.playback_url]) {
      if (!value) continue;
      const url = new URL(value), origin = new URL(this.bridge.api.origin);
      if (url.username || url.password || url.origin !== origin.origin && !(this.bridge.api.dev && url.hostname === origin.hostname && url.protocol === 'https:')) fail('invalid_response', 'Invalid walkthrough review link.');
    }
    return item;
  }

  async list(input: { after_id?: string; through_id?: string; article_id?: string } = {}, context?: Context) {
    context ??= await this.supported();
    const binding = await this.bridge.binding();
    if (context.project.id !== binding.project_id) fail('destination_mismatch', 'The project changed while reading walkthroughs.');
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(input)) if (value !== undefined) query.set(key, parse(key === 'through_id' ? z.string().regex(/^\d+$/) : remoteId, value));
    const page = parse(pageSchema, await this.bridge.api.request('GET', `/projects/${binding.project_id}/walkthroughs${query.size ? `?${query}` : ''}`), 'invalid_response');
    if (page.project_id !== binding.project_id || input.through_id !== undefined && page.through_id !== input.through_id) fail('invalid_response', 'The walkthrough inventory changed project or bounds.');
    let previous = BigInt(input.after_id ?? '0');
    for (const item of page.walkthroughs) {
      this.check(item, binding.project_id);
      if (BigInt(item.id) <= previous || BigInt(item.id) > BigInt(page.through_id) || input.article_id && item.article_id !== input.article_id) fail('invalid_response', 'Invalid walkthrough inventory page.');
      previous = BigInt(item.id);
    }
    if (page.next_cursor && page.next_cursor !== page.walkthroughs.at(-1)?.id) fail('invalid_response', 'Invalid walkthrough cursor.');
    return page;
  }

  async get(id: string) {
    parse(remoteId, id);
    await this.supported();
    const binding = await this.bridge.binding();
    const item = this.check(parse(walkthroughSchema, await this.bridge.api.request('GET', `/projects/${binding.project_id}/walkthroughs/${id}`), 'invalid_response'), binding.project_id);
    if (item.id !== id) fail('invalid_response', 'The server returned another walkthrough.');
    return item;
  }

  // Called under the project sync lock. The caller commits the combined article
  // and video snapshot only after both complete inventories have been validated.
  async refresh(context: Context, previous?: unknown) {
    if (!context.walkthrough_sync) return { status: 'unsupported' as const, instructions: 'Update the SupportPages server to sync video walkthroughs.' };
    const binding = await this.bridge.binding();
    const prior = snapshotSchema.safeParse(previous);
    const known = new Map(prior.success && prior.data.project_id === binding.project_id && prior.data.api_origin === binding.api_origin ? prior.data.items.map(item => [item.id, item.remote ?? item.last_known]) : []);
    const rows: z.infer<typeof walkthroughSchema>[] = [];
    let cursor: string | undefined, through: string | undefined;
    do {
      const page = await this.list({ after_id: cursor, through_id: through }, context);
      rows.push(...page.walkthroughs);
      if (rows.length > 100_000) fail('inventory_truncated', 'Too many walkthroughs to sync. The previous snapshot has been kept.');
      through = page.through_id;
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    const items: z.infer<typeof snapshotSchema>['items'] = rows.map(remote => {
      const before = known.get(remote.id);
      known.delete(remote.id);
      return { id: remote.id, remote, sync_status: !before ? 'remote_only' : before.revision === remote.revision ? 'synced' : 'remote_changed' };
    });
    for (const [id, last_known] of known) items.push({ id, remote: null, last_known, sync_status: 'unavailable' });
    return { status: 'ready' as const, synced_at: new Date().toISOString(), project_id: binding.project_id, api_origin: binding.api_origin, items,
      counts: { remote: rows.length, changed: items.filter(item => item.sync_status === 'remote_changed').length, unavailable: known.size },
      instructions: 'Current walkthrough metadata is refreshed. Missing videos are unavailable (removed or their article is no longer accessible); last_known is historical. Reads never regenerate or share a video.' };
  }
}
