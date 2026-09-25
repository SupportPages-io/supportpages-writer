import type { Run } from './runs.js';

export const articleChatInstruction = 'Keep user-facing chat focused on the SupportPages.io editor link, article progress, review and publication. Do not mention local assets, saved files, filesystem paths, output directories, filenames, rendering scripts or validation reports in routine progress, completion or failure messages. These are internal execution details, not deliverables to list or download. Explain failures in terms of their effect on the article and the next action, with the editor link when available. If delivery fails, say that the latest changes could not be confirmed in the editor; do not claim the editor is up to date or reassure the user that assets are saved locally. Share technical file details only when the user explicitly asks for them.';

export const showArticleLinkInstruction = articleChatInstruction + ' Always show the returned article link in your next user-facing message, before launching or retrying the writer. Repeat it even if this article already existed, the link was shown earlier, or the operation failed. Do not wait for article text, images or completion. If no confirmed link is available, say so and explain the reported problem; never invent a URL. Showing a link does not mean opening the browser or publishing.';

/** Local workspaces have no editor: the saved Markdown path is the deliverable. */
export const localChatInstruction = 'This folder saves articles locally; there is no SupportPages.io editor or help centre for it. The saved Markdown path is the deliverable: show it in your completion message, with the number of screenshots. Keep progress messages concise and free of intermediate filenames, rendering scripts or validation reports. Never ask whether to publish automatically; hosting needs an account. If the user explicitly asks to host or publish saved local articles, ask whether to sign in or create a free SupportPages.io account, then use supportpages_publish. Any hosting offer comes from complete_article as hosting_invitation; do not add your own.';

export const localLinkInstruction = localChatInstruction + ' Do not invent an editor URL; there is none for this article.';

export function articleLink(run: Run) {
  if (run.export_path) return { editor_url: null, link_message: `Saved to ${run.export_path}`, link_instructions: localLinkInstruction };
  const editor_url = run.remote?.editor_url ?? run.progress?.article?.editor_url ?? null;
  return { editor_url, link_message: editor_url ? `View article: ${editor_url}` : 'No confirmed article link is available yet.',
    link_instructions: showArticleLinkInstruction };
}

/** Keep the URL visible as a separate MCP text item as well as structured data. */
export function articleLinkContent(value: unknown) {
  if (!value || typeof value !== 'object') return [];
  const data = value as Record<string, any>;
  const url = data.editor_url ?? data.article_run?.editor_url ?? data.details?.editor_url ?? data.article?.editor_url;
  if (typeof url !== 'string') return [];
  // Guidance is already in server instructions and structured responses. Keep
  // this visible text item useful without repeating that policy on every call.
  return [{ type: 'text' as const, text: `View article: ${url}` }];
}
