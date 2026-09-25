import { z } from 'zod';
import { writerCapabilitiesSchema } from './actions.js';
export const idSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(120);
export const remoteId = z.string().regex(/^[1-9][0-9]*$/);
export const articleType = z.enum(['how-to', 'troubleshooting', 'concept', 'faq']);
const text = z.string().max(200_000);
const title = z.string().trim().min(1).max(500);
const common = { id: idSchema };
export const articleSchema = z.strictObject({
  schema_version: z.literal(2), title, article_type: articleType,
  blocks: z.array(z.discriminatedUnion('type', [
    z.strictObject({ ...common, type: z.literal('prose'), presentation: z.enum(['lead', 'body', 'summary']), title: text.nullish(), content: text }),
    z.strictObject({ ...common, type: z.literal('section'), presentation: z.enum(['numbered', 'plain']), title, content: text, has_image: z.boolean() }),
    z.strictObject({ ...common, type: z.literal('list'), presentation: z.enum(['bullets', 'checklist', 'tips']), title, items: z.array(text).max(500) }),
  ])).min(1).max(500),
}).superRefine((article, ctx) => {
  const ids = article.blocks.map(b => b.id);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'Block IDs must be unique', path: ['blocks'] });
});
export type Article = z.infer<typeof articleSchema>;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const manifestSchema = z.strictObject({
  bundle_version: z.literal(1), local_article_id: z.uuid(), run_id: z.uuid(),
  skills_version: z.string().max(100), source_commit: z.string().nullable(), source_dirty: z.boolean(),
  section_id: remoteId.nullable(), article_sha256: hash,
  images: z.array(z.strictObject({ block_id: idSchema, filename: z.string(), sha256: hash, size: z.number().int().positive().max(10 * 1024 * 1024), mime_type: z.literal('image/png') })).max(30),
  bundle_hash: hash,
});
export type Manifest = z.infer<typeof manifestSchema>;
export const bindingSchema = z.strictObject({ version: z.literal(1), project_id: remoteId, api_origin: z.url() });
export type Binding = z.infer<typeof bindingSchema>;
/** A workspace that saves finished articles locally instead of (or before) uploading them. */
export const localSchema = z.strictObject({ version: z.literal(1), export_dir: z.string().min(1).max(500),
  writing_style: z.string().max(100).optional(),
  preferences: z.object({ prefer_background: z.boolean(), open_when_ready: z.boolean() }).optional() });
export type LocalSettings = z.infer<typeof localSchema>;
export const repositoryConnectionSchema = z.object({
  writer: writerCapabilitiesSchema.optional(),
  state: z.enum(['not_connected', 'connected', 'disconnected', 'suspended']),
  connect_url: z.url(),
  capabilities: z.object({ sections: z.boolean(), suggestions: z.boolean(), code_analysis: z.boolean(), maintenance: z.boolean() }),
});
export const remoteArticleSchema = z.object({ repository_connection: repositoryConnectionSchema.optional(), id: remoteId, revision: hash, status: z.enum(['draft', 'published']), editor_url: z.url(), public_url: z.url().nullable() });
export const importResponseSchema = z.object({ import_id: remoteId, article: remoteArticleSchema });
const browserUrl = z.url().max(2000).refine(value => {
  const url = new URL(value);
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
});
export const articleCapacitySchema = z.object({
  used: z.number().int().nonnegative(), limit: z.number().int().nonnegative().nullable(), can_create: z.boolean(),
  upgrade_url: browserUrl, manage_articles_url: browserUrl,
}).refine(value => value.can_create === (value.limit === null || value.used < value.limit));
export const contextSchema = z.object({
  local: z.boolean().optional(),
  article_sync: z.boolean().optional(),
  walkthrough_sync: z.boolean().optional(),
  article_capacity: articleCapacitySchema.optional(),
  progressive_articles: z.boolean().optional(),
  repository_connection: repositoryConnectionSchema.optional(),
  // A local workspace has no remote project; every bound path compares the id to a binding.
  project: z.object({ id: remoteId.optional(), name: z.string(), help_centre_url: z.url().optional() }),
  supported_bundle_versions: z.array(z.number()),
  sections: z.array(z.object({ id: remoteId, name: z.string(), slug: z.string(), description: z.string().nullable().optional(), icon: z.string().nullable().optional() })),
  articles: z.array(z.object({ id: remoteId, title: z.string(), section_id: remoteId.nullable() })).default([]),
  product_context: z.record(z.string(), z.union([z.string(), z.array(z.string()), z.null()])).optional(),
  inventory_truncated: z.boolean().default(false),
  project_overview: z.string().nullable().optional(), analysis_summary: z.string().nullable().optional(), writing_style: z.string().optional(),
});
