import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { z } from 'zod';
import { marked } from 'marked';
import { articleSchema, manifestSchema, type Article, type Manifest } from './schema.js';
import { Workspace } from './workspace.js';
import { fail } from './errors.js';
export const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  return JSON.stringify(value);
}
export function parse<T>(schema: z.ZodType<T>, value: unknown, code = 'invalid_artifact'): T {
  const result = schema.safeParse(value);
  if (!result.success) fail(code, 'Data does not match the expected contract.', result.error.issues.map(i => ({ path: i.path, message: i.message })));
  return result.data;
}
export type Snapshot = { article: Article; articleBytes: Buffer; images: { block_id: string; filename: string; bytes: Buffer }[]; warnings: string[] };
/** Read the latest usable preview without requiring finished screenshots or lint. */
export async function progressSnapshot(ws: Workspace, dir: string, options: {
  imageHashes?: Record<string, string>; fallbackDir?: string;
} = {}): Promise<Snapshot | undefined> {
  let articleBytes: Buffer, article: Article;
  try {
    articleBytes = await ws.read(`${dir}/article.json`);
    article = parse(articleSchema, JSON.parse(articleBytes.toString()));
    if (!article.blocks.some(block => block.type === 'list' ? block.items.some(item => item.trim()) : block.content.trim())) return;
  } catch { return; } // A partially written article is not a generation failure.
  const images: Snapshot['images'] = [];
  let size = articleBytes.length;
  for (const block of article.blocks) {
    if (block.type !== 'section' || !block.has_image) continue;
    const filename = `block_${block.id}.png`;
    for (const directory of [dir, ...(options.fallbackDir ? [options.fallbackDir] : [])]) {
      try {
        const bytes = await ws.read(`${directory}/${filename}`, 10 * 1024 * 1024);
        if (bytes.length < 45 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.readUInt32BE(8) !== 13 || bytes.subarray(12, 16).toString() !== 'IHDR' || bytes.subarray(-12).toString('hex') !== '0000000049454e44ae426082') continue;
        if (!bytes.readUInt32BE(16) || !bytes.readUInt32BE(20) || bytes.readUInt32BE(16) * bytes.readUInt32BE(20) > 40_000_000) continue;
        if (options.imageHashes?.[block.id] === sha256(bytes)) break;
        size += bytes.length;
        if (size > 40 * 1024 * 1024 || images.length >= 30) return { article, articleBytes, images, warnings: [] };
        images.push({ block_id: block.id, filename, bytes });
        break;
      } catch { /* Keep the last exported image while its replacement is written. */ }
    }
  }
  return { article, articleBytes, images, warnings: [] };
}
export async function snapshot(ws: Workspace, dir: string, startedAt?: string): Promise<Snapshot> {
  const articleBytes = await ws.read(`${dir}/article.json`);
  let value: unknown;
  try { value = JSON.parse(articleBytes.toString()); } catch { fail('invalid_artifact', 'article.json is not valid JSON.'); }
  const article = parse(articleSchema, value);
  const images: Snapshot['images'] = [];
  let total = articleBytes.length;
  for (const block of article.blocks) {
    if (block.type !== 'section' || !block.has_image) continue;
    const filename = `block_${block.id}.png`;
    const bytes = await ws.read(`${dir}/${filename}`, 10 * 1024 * 1024);
    // PNG signature, IHDR length/type, sane raster bounds, and terminal IEND.
    if (bytes.length < 45 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.readUInt32BE(8) !== 13 || bytes.subarray(12, 16).toString() !== 'IHDR' || !bytes.subarray(-12).equals(Buffer.from('0000000049454e44ae426082', 'hex'))) fail('invalid_artifact', `${filename} is not a complete PNG.`);
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    if (!width || !height || width * height > 40_000_000) fail('invalid_artifact', `${filename} has invalid or excessive dimensions.`);
    total += bytes.length;
    if (total > 40 * 1024 * 1024 || images.length >= 30) fail('bundle_too_large', 'Bundles are limited to 40 MiB and 30 screenshots.');
    images.push({ block_id: block.id, filename, bytes });
  }
  const warnings: string[] = [];
  if (await ws.exists(`${dir}/lint_report.json`)) {
    const report = parse(z.object({ all_passed: z.boolean(), global_warnings: z.array(z.string()).optional() }).passthrough(), await ws.json(`${dir}/lint_report.json`));
    if (!report.all_passed) fail('quality_check_failed', 'The fidelity lint failed. Fix its report before finalizing the article.');
    warnings.push(...(report.global_warnings ?? []));
  } else warnings.push('No fidelity lint report is present; structural validation does not establish source fidelity.');
  if (startedAt) {
    for (const name of ['article.json', 'lint_report.json', ...images.map(image => image.filename)]) {
      const info = await stat(await ws.resolve(`${dir}/${name}`)).catch(() => fail('incomplete_generation', `Missing final ${name}.`));
      if (info.mtimeMs < Date.parse(startedAt)) fail('stale_artifact', `${name} predates the generation run.`);
    }
  }
  return { article, articleBytes, images, warnings };
}
export function createManifest(snap: Snapshot, metadata: Pick<Manifest, 'local_article_id' | 'run_id' | 'skills_version' | 'source_commit' | 'source_dirty' | 'section_id'>): Manifest {
  const base = {
    bundle_version: 1 as const, local_article_id: metadata.local_article_id, run_id: metadata.run_id, skills_version: metadata.skills_version, source_commit: metadata.source_commit, source_dirty: metadata.source_dirty, section_id: metadata.section_id, article_sha256: sha256(snap.articleBytes),
    images: snap.images.map(i => ({ block_id: i.block_id, filename: i.filename, sha256: sha256(i.bytes), size: i.bytes.length, mime_type: 'image/png' as const })),
  };
  return parse(manifestSchema, { ...base, bundle_hash: sha256(canonical(base)) });
}
export async function verifyBundle(ws: Workspace, dir: string) {
  const manifest = parse(manifestSchema, await ws.json(`${dir}/manifest.json`));
  const snap = await snapshot(ws, dir);
  const expected = createManifest(snap, manifest);
  // createManifest only takes the explicitly selected provenance fields below.
  if (expected.bundle_hash !== manifest.bundle_hash || canonical(expected.images) !== canonical(manifest.images) || expected.article_sha256 !== manifest.article_sha256) fail('artifact_changed', 'The finalized bundle changed. Finalize the source article again before uploading.');
  return { manifest, snap };
}
const escape = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
function markdown(s: string) {
  // Only render inline formatting; raw HTML, links, and images become inert text.
  const renderer = new marked.Renderer();
  renderer.html = ({ text }) => escape(text);
  renderer.link = ({ text }) => escape(text);
  renderer.image = ({ text }) => escape(text);
  return marked.parse(s, { renderer, async: false });
}
export function preview(snap: Snapshot): string {
  const blocks = snap.article.blocks.map(block => {
    let html = 'title' in block && block.title ? `<h2>${escape(block.title)}</h2>` : '';
    if (block.type === 'list') html += '<ul>' + block.items.map(i => `<li>${markdown(i)}</li>`).join('') + '</ul>';
    else html += markdown(block.content);
    const img = snap.images.find(i => i.block_id === block.id);
    if (img) html += `<img alt="${escape('title' in block ? block.title ?? '' : '')}" src="data:image/png;base64,${img.bytes.toString('base64')}">`;
    return `<section>${html}</section>`;
  }).join('\n');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${escape(snap.article.title)}</title><style>body{font:17px/1.65 system-ui,sans-serif;color:#18212f;background:#f6f7f9;margin:0}main{max-width:800px;margin:32px auto;padding:40px;background:white;border-radius:12px}h1,h2{line-height:1.25}h1{font-size:34px}h2{margin-top:32px;font-size:23px}img{max-width:100%;height:auto;border:1px solid #ddd;border-radius:8px}code{white-space:pre-wrap}aside{color:#586174;font-size:14px}</style><main><aside>Local preview · ${escape(snap.article.article_type)}</aside><h1>${escape(snap.article.title)}</h1>${blocks}</main></html>`;
}
