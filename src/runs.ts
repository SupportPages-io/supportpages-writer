import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Workspace } from './workspace.js';
import { remoteId, remoteArticleSchema } from './schema.js';
import { parse } from './artifacts.js';
import { fail } from './errors.js';
import { articleLink } from './article-link.js';
import { repositoryInvitationSchema } from './repository-benefits.js';
import { hostingInvitationSchema } from './hosting-benefits.js';

export const processSessionId = randomUUID();
export const runSchema = z.object({
  id: z.uuid(), local_article_id: z.uuid(), artifact_dir: z.string(), started_at: z.string(),
  section_id: remoteId.nullable(), status: z.enum(['prepared', 'finalized', 'cancelled', 'failed', 'interrupted']), skills_version: z.string(),
  article_type: z.string().optional(),
  progress: z.object({
    attempt: z.uuid(), next_attempt: z.uuid().optional(), article: remoteArticleSchema.optional(),
    sequence: z.number().int().nonnegative(), article_hash: z.string().optional(),
    image_hashes: z.record(z.string(), z.string()).optional(), last_heartbeat: z.number().optional(),
    open_attempted: z.boolean().optional(), browser_opened: z.boolean().optional(),
    sync_error: z.string().optional(), sync_failures: z.number().int().nonnegative().optional(),
    pending: z.object({ sequence: z.number().int().positive(), directory: z.string() }).optional(),
  }).optional(),
  title: z.string().optional(), api_origin: z.string().optional(), project_id: remoteId.optional(),
  codebase_dir: z.string().optional(),
  prefer_background: z.boolean().optional(), open_when_ready: z.boolean().optional(),
  execution_mode: z.enum(['background', 'foreground']).optional(), host_task_id: z.string().max(200).optional(),
  writer_token: z.uuid().optional(), writer_started_at: z.iso.datetime().optional(),
  writer_completed_at: z.iso.datetime().optional(),
  first_writer_started_at: z.iso.datetime().optional(), ready_for_review_at: z.iso.datetime().optional(),
  repository_invitation: repositoryInvitationSchema.optional(), repository_reminder_checked: z.boolean().optional(),
  hosting_invitation: hostingInvitationSchema.optional(), hosting_reminder_checked: z.boolean().optional(),
  session_id: z.string().optional(), updated_at: z.string().optional(),
  phase: z.enum(['prepared', 'writing', 'finalizing', 'uploading', 'upload_failed', 'ready_for_review', 'published', 'saved', 'failed', 'interrupted', 'cancelled']).optional(),
  bundle_dir: z.string().optional(), bundle_hash: z.string().optional(),
  // Preview exports do not mean the writer has finished or passed validation.
  local_export: z.object({ directory: z.string(), markdown_path: z.string().optional(), sync_error: z.string().optional() }).optional(),
  export_path: z.string().optional(),
  remote: remoteArticleSchema.optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
export type Run = z.infer<typeof runSchema>;
export function uploadRecovery(run: Run): string {
  const reason = run.error?.code === 'plan_limit'
    ? 'Free up article capacity or update the account plan.'
    : ['permission_denied', 'invalid_credentials'].includes(run.error?.code ?? '')
      ? 'Check the token permissions and project access; reconnect with supportpages init if needed.'
      : ['run_closed', 'revision_conflict', 'article_deleted', 'article_unavailable'].includes(run.error?.code ?? '')
        ? 'Review the existing article in the web app. Do not overwrite browser changes or restart a closed run.'
        : 'Resolve the reported upload problem.';
  const retry = ['run_closed', 'revision_conflict', 'article_deleted', 'article_unavailable'].includes(run.error?.code ?? '') ? ''
    : ` Then retry supportpages_complete_article with run_id=${run.id} and completed=true to reuse the saved bundle.`;
  return `${reason}${retry} Do not regenerate the article or report the writer as failed because delivery failed. Local upload state does not prove that no remote draft exists.`;
}

export class Runs {
  constructor(private ws: Workspace, private root: string, private sessionId = processSessionId) {}
  async read(id: string) {
    parse(z.uuid(), id, 'invalid_run');
    const file = `${this.root}/runs/${id}/run.json`;
    if (!await this.ws.exists(file)) fail('invalid_run', 'This run does not belong to the selected workspace and API origin.');
    const run = parse(runSchema, await this.ws.json(file));
    if (run.id !== id) fail('invalid_run', 'Run identity mismatch.');
    return run;
  }
  // Caller holds the workspace operation lock for all writes and reservations.
  async save(run: Run) {
    const previous = await this.ws.exists(`${this.root}/runs/${run.id}/run.json`) ? await this.read(run.id) : undefined;
    const now = new Date().toISOString();
    const value = { ...run, updated_at: now,
      first_writer_started_at: previous?.first_writer_started_at ?? run.first_writer_started_at ?? previous?.writer_started_at ?? run.writer_started_at,
      ready_for_review_at: previous?.ready_for_review_at ?? run.ready_for_review_at ?? (run.phase === 'ready_for_review' ? now : undefined),
      repository_reminder_checked: previous?.repository_reminder_checked ?? run.repository_reminder_checked,
      repository_invitation: previous?.repository_invitation ?? run.repository_invitation,
      hosting_reminder_checked: previous?.hosting_reminder_checked ?? run.hosting_reminder_checked,
      hosting_invitation: previous?.hosting_invitation ?? run.hosting_invitation };
    await this.ws.writeJson(`${this.root}/runs/${run.id}/run.json`, value);
    const activeFile = `${this.root}/active-run.json`;
    if (await this.ws.exists(activeFile) && parse(runSchema, await this.ws.json(activeFile)).id === run.id) {
      await this.ws.writeJson(activeFile, value);
    }
  }
  async blocking(allowedId?: string) {
    // Include legacy active-run files. All environments share the skills' outputs.
    const roots = ['.rtfm/supportpages'];
    for (const entry of await this.ws.list('.rtfm/supportpages/dev')) {
      if (entry.isDirectory()) roots.push(`.rtfm/supportpages/dev/${entry.name}`);
    }
    for (const root of roots) {
      const file = `${root}/active-run.json`;
      if (!await this.ws.exists(file)) continue;
      const pointer = parse(runSchema, await this.ws.json(file));
      const record = `${root}/runs/${pointer.id}/run.json`;
      const active = await this.ws.exists(record) ? parse(runSchema, await this.ws.json(record)) : pointer;
      if (active.status === 'prepared' && !(root === this.root && active.id === allowedId)) {
        return { run: active, state_directory: root };
      }
    }
    return null;
  }
  async assertAvailable(allowedId?: string) {
    const active = await this.blocking(allowedId);
    if (active) fail('generation_active', 'Finish or stop and cancel the existing writer before starting another in this workspace.', { run_id: active.run.id, state_directory: active.state_directory });
  }
  async progress(id?: string) {
    let run: Run;
    if (id) run = await this.read(id);
    else {
      if (!await this.ws.exists(`${this.root}/active-run.json`)) return null;
      const active = parse(runSchema, await this.ws.json(`${this.root}/active-run.json`));
      run = await this.read(active.id);
    }
    // Interpret older journals without rewriting them: a finalized run whose
    // delivery failed is still a completed local article, not a failed writer.
    const uploadFailed = run.phase === 'upload_failed' || (run.status === 'finalized' && run.phase === 'failed');
    const deliveryPending = Boolean(run.writer_completed_at && !run.remote && run.phase !== 'saved');
    return { run_id: run.id, title: run.title, phase: uploadFailed ? 'upload_failed' : run.phase ?? (run.status === 'finalized' ? 'finalizing' : run.status),
      generation_completed_locally: run.status === 'finalized',
      delivery_pending: deliveryPending,
      recovery: uploadFailed ? uploadRecovery(run) : deliveryPending
        ? (run.project_id
          ? `Writing has finished but final delivery is pending. Call supportpages_complete_article with run_id=${run.id} and completed=true; do not regenerate or claim the editor is ready.`
          : `Writing has finished but the article has not been saved yet. Call supportpages_complete_article with run_id=${run.id} and completed=true to save it; do not regenerate.`) : undefined,
      artifact_dir: run.artifact_dir, execution_mode: run.execution_mode, host_task_id: run.host_task_id,
      progress_source: 'last_reported', session_current: run.session_id === this.sessionId,
      started_at: run.started_at, updated_at: run.updated_at ?? run.started_at,
      project_id: run.project_id, error: run.error, article: run.remote, export_path: run.export_path,
      preview: run.progress?.article, local_preview_path: run.local_export?.markdown_path,
      synchronization_error: run.progress?.sync_error ?? run.local_export?.sync_error,
      ...articleLink(run), open_when_ready: Boolean(run.open_when_ready && !run.progress?.open_attempted), browser_opened: run.progress?.browser_opened,
      instructions: run.status === 'prepared' && run.session_id !== this.sessionId
        ? 'Progress is from an earlier MCP session. Verify the host task before completing, stopping, or restarting it; do not start a duplicate writer.' : undefined };
  }
}
