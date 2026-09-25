import path from 'node:path';
import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Workspace } from './workspace.js';
import type { Snapshot } from './artifacts.js';

export const markdownFilename = 'index.md';
const alt = (value: string) => value.replace(/[\[\]]/g, '\\$&').replace(/\s+/g, ' ').trim();

/** Portable Markdown for docs folders: headings per block, images referenced beside the file. */
export function renderMarkdown(snap: Snapshot): string {
  const parts: string[] = [`# ${snap.article.title.trim()}`];
  let step = 0;
  for (const block of snap.article.blocks) {
    if (block.type === 'prose') {
      const heading = block.presentation === 'summary' ? (block.title?.trim() || 'Summary') : block.title?.trim();
      if (heading && block.presentation !== 'lead') parts.push(`## ${heading}`);
      parts.push(block.content.trim());
    } else if (block.type === 'section') {
      parts.push(`## ${block.presentation === 'numbered' ? `${++step}. ` : ''}${block.title.trim()}`);
      if (block.content.trim()) parts.push(block.content.trim());
      const image = snap.images.find(item => item.block_id === block.id);
      if (image) parts.push(`![${alt(block.title)}](./${image.filename})`);
    } else {
      parts.push(`## ${block.title.trim()}`);
      const items = block.items.map(item => item.trim()).filter(Boolean);
      if (!items.length) continue;
      const prefix = block.presentation === 'checklist' ? '- [ ] ' : block.presentation === 'tips' ? '> **Tip:** ' : '- ';
      parts.push(items.map(item => prefix + item).join(block.presentation === 'tips' ? '\n>\n' : '\n'));
    }
  }
  return parts.join('\n\n') + '\n';
}

// Exported files are meant for other tools and version control, so they take
// the user's umask rather than the private modes used for workspace state.
async function writePublic(target: string, data: string | Buffer) {
  // Polling an unchanged preview must not trigger file watchers or rebuilds.
  try { if ((await readFile(target)).equals(Buffer.from(data))) return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx');
  try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
  try { await rename(temporary, target); } finally { await rm(temporary, { force: true }); }
}

/** Write `<exportDir>/<slug>/index.md` plus the screenshots it references. Re-exports replace stale files. */
export async function exportArticle(ws: Workspace, snap: Snapshot, artifactDir: string, exportDir: string, slug: string) {
  const relativeTarget = path.posix.join(exportDir, slug);
  const target = await ws.resolve(relativeTarget);
  const source = await ws.resolve(artifactDir);
  const markdown = await ws.resolve(`${relativeTarget}/${markdownFilename}`);
  if (target !== source) {
    for (const image of snap.images) await writePublic(await ws.resolve(`${relativeTarget}/${image.filename}`), image.bytes);
  }
  // Publish references only after their PNGs exist; remove stale PNGs afterwards.
  await writePublic(markdown, renderMarkdown(snap));
  if (target !== source) {
    const keep = new Set(snap.images.map(image => image.filename));
    let entries: string[] = [];
    try { entries = await readdir(target); } catch { /* Created above; nothing stale. */ }
    for (const name of entries) {
      if (/^block_[a-z0-9-]+\.png$/.test(name) && !keep.has(name)) await rm(await ws.resolve(`${relativeTarget}/${name}`), { force: true });
    }
  }
  return { markdown_path: markdown, export_dir: target, image_count: snap.images.length };
}
