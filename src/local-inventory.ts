import path from 'node:path';
import { z } from 'zod';
import type { Bridge } from './bridge.js';
import { publicError } from './errors.js';

/** Inspect current article files, without syncing, signing in or changing setup. */
export async function localArticleInventory(bridge: Bridge) {
  const { ws } = bridge;
  const local = await bridge.local();
  const roots = [...new Set([local?.export_dir, 'output/articles'].filter((value): value is string => Boolean(value)))];
  const saved = await bridge.localArticles();
  const directories = new Map<string, string>();
  for (const root of roots) {
    for (const entry of await ws.list(root)) {
      if (entry.isDirectory()) directories.set(path.posix.join(root, entry.name), entry.name);
    }
  }
  for (const item of saved) directories.set(item.artifact_dir, item.slug);

  const articles = new Map<string, { slug: string; title: string; artifact_dir: string; article_path?: string; export_path?: string; local_article_id?: string; run_id?: string }>();
  const warnings: { path: string; message: string }[] = [];
  for (const [directory, slug] of directories) {
    let title: string | undefined, articlePath: string | undefined, exportPath: string | undefined;
    for (const filename of ['article.json', 'index.md']) {
      const relative = path.posix.join(directory, filename);
      try {
        if (!await ws.exists(relative)) continue;
        if (filename === 'article.json') {
          const article = z.object({ title: z.string().trim().min(1) }).parse(await ws.json(relative));
          title = article.title;
          articlePath = await ws.resolve(relative);
        } else {
          const markdown = (await ws.read(relative)).toString('utf8');
          title ??= markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() || slug;
          exportPath = await ws.resolve(relative);
        }
      } catch (error) {
        if (publicError(error).code === 'invalid_path') throw error;
        warnings.push({ path: relative, message: 'Could not read this local article file.' });
      }
    }
    if (!articlePath && !exportPath) continue;
    const state = saved.find(item => item.slug === slug);
    const existing = articles.get(slug);
    // The configured export is preferred; the source folder can supply its JSON.
    articles.set(slug, { slug, title: title ?? slug, artifact_dir: directory,
      ...(state ? { local_article_id: state.local_article_id, run_id: state.run_id } : {}), ...existing,
      ...(existing?.article_path || !articlePath ? {} : { article_path: articlePath }),
      ...(existing?.export_path || !exportPath ? {} : { export_path: exportPath }) });
  }
  return { status: 'local' as const, source: 'local' as const, articles: [...articles.values()].sort((a, b) => a.title.localeCompare(b.title)),
    next_cursor: null, searched_directories: [...new Set([...roots, ...saved.map(item => item.artifact_dir)])], warnings,
    instructions: 'Report the local articles and their file paths. An empty list means no local articles were found in the searched directories; it says nothing about hosted articles. Use these files, not git status, as the inventory. Do not request sign-in or start setup for this local listing. Only offer hosted access if the user explicitly asks for articles on SupportPages.io.' };
}
