import { HostedOperations } from './hosted-operations.js';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { resolveAction, requireExecution } from './actions.js';
import { ApiClient, connectionStateRoot } from './api.js';
import { preferences, defaultPreferences } from './settings.js';
import { Workspace } from './workspace.js';
import { bindingSchema, localSchema as localSettingsSchema, manifestSchema, contextSchema, importResponseSchema, remoteArticleSchema, remoteId, idSchema, articleType, type Binding, type LocalSettings } from './schema.js';
import { createManifest, parse, preview, snapshot, verifyBundle } from './artifacts.js';
import { fail, publicError } from './errors.js';
import { checkArticleCapacity } from './capacity.js';
import { pluginName, writerAgentName, writerAgentType, claudeWriterAgents, writerLaunchInstruction, codexWriterLaunchInstruction, backgroundParentInstruction, writerReportingInstruction, writerPermissionInstruction } from './writer-agent.js';
import { writerEntry, writerScreenshotLimit } from './writer-entry.js';
import { articleChatInstruction, localChatInstruction, articleLink } from './article-link.js';
import { composeWritingStyle } from './writing-style.js';
import { exportArticle } from './export.js';
import { executionSettings } from './agent-settings.js';
import { LocalSetup } from './local-setup.js';
import { localArticleInventory } from './local-inventory.js';
import { ProjectSync } from './sync.js';
const exec = promisify(execFile);
import { ProgressRelay, progressResponse } from './progress.js';
import { Runs, runSchema, processSessionId, uploadRecovery, type Run } from './runs.js';
import { RepositoryReminders, repositoryShowText, type RepositoryInvitation } from './repository-benefits.js';
import { HostingReminders, hostingShowText, type HostingInvitation } from './hosting-benefits.js';
import { activeTelemetry, secondsSince, track } from './telemetry.js';
/** What to do about an analysis that is missing or was rejected by validation. */
export function analysisInstruction(analysis: { status: string; app_type?: unknown; error?: { message?: string } }) {
  if (analysis.status === 'ready') return undefined;
  const appType = typeof analysis.app_type === 'string' ? analysis.app_type : undefined;
  const reason = analysis.error?.message ? `${analysis.error.message} ` : '';
  if (appType) {
    return `${reason}Project detection needs the app type it asked for. In the project terminal run supportpages analyse --app-type ${appType}, or rerun the detect-project skill with app_type=${appType}.`;
  }
  return analysis.status === 'invalid'
    ? `${reason}Run supportpages analyse in the project terminal to rebuild the project analysis.`
    : 'Run supportpages analyse in the project terminal before creating an article.';
}

/** Counts a locally written article's end state: saved in the folder, or uploaded to a help centre. */
function trackArticle(run: Run, outcome: 'succeeded' | 'failed' | 'upload_failed' | 'cancelled' | 'interrupted', errorCode?: string) {
  track('article_completed', { location: run.project_id ? 'upload' : 'local', outcome, error_code: errorCode, duration_s: secondsSince(run.first_writer_started_at) });
}
const localSchema = z.object({ project_id: remoteId.optional(), api_origin: z.url().optional(), local_article_id: z.uuid(), artifact_dir: z.string(), bundle_dir: z.string(), bundle_hash: z.string(), uploaded_bundle_hash: z.string().optional(), remote: remoteArticleSchema.optional() });
export class Bridge {
  readonly relay = new ProgressRelay(this);
  private operations: Promise<unknown> = Promise.resolve();
  lock<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operations.then(() => this.ws.lock(operation));
    this.operations = result.catch(() => {});
    return result;
  }
  close() { this.relay.stop(); return this.operations; }
  get stateRoot() { return connectionStateRoot(this.api.origin, this.api.dev); }
  constructor(public ws: Workspace, public api: ApiClient, public skillsDir: string, private sessionId = processSessionId,
    private source?: { source_commit: string | null; source_dirty: boolean }, private configDir?: string) {}
  async repositoryReminders(enabled?: boolean) {
    const binding = await this.binding();
    return new RepositoryReminders(this.configDir).preference(this.api.origin, binding.project_id, enabled);
  }
  /** Needs no help centre or sign-in: the preference belongs to this device's local folders. */
  hostingReminders(enabled?: boolean) {
    return new HostingReminders(this.configDir).preference(this.api.origin, enabled);
  }
  get runs() { return new Runs(this.ws, this.stateRoot, this.sessionId); }
  async resumeWriterCompletion() {
    const file = `${this.stateRoot}/active-run.json`;
    if (!await this.ws.exists(file)) return;
    const active = parse(runSchema, await this.ws.json(file));
    const run = await this.runs.read(active.id);
    if (run.writer_completed_at && !run.remote && !run.error && run.phase !== 'saved' && ['prepared', 'finalized'].includes(run.status)) this.relay.start(run.id);
  }
  get setup() { return new LocalSetup(this.ws, this.stateRoot); }
  sync() { return this.lock(() => new ProjectSync(this).refresh()); }
  async localPlan() {
    return { analysis: await this.setup.analysis() };
  }
  /** Settings of a workspace that saves articles locally; undefined when never set up that way. */
  async local(): Promise<LocalSettings | undefined> {
    if (!await this.ws.exists(`${this.stateRoot}/local.json`)) return undefined;
    return parse(localSettingsSchema, await this.ws.json(`${this.stateRoot}/local.json`), 'invalid_configuration');
  }
  async saveLocal(settings: LocalSettings) {
    await this.ws.resolve(settings.export_dir);
    const fresh = !await this.ws.exists(`${this.stateRoot}/local.json`);
    await this.ws.writeJson(`${this.stateRoot}/local.json`, parse(localSettingsSchema, settings, 'invalid_configuration'));
    if (fresh) track('project_init', { location: 'local' });
    return settings;
  }
  /** A saved help-centre link always wins over local settings left behind by publish. */
  async destination(): Promise<'hosted' | 'local' | 'none'> {
    if (await this.ws.exists(`${this.stateRoot}/binding.json`)) return 'hosted';
    return await this.ws.exists(`${this.stateRoot}/local.json`) ? 'local' : 'none';
  }
  /** Context for a local workspace: no sections, inventory or capacity; writing style composed here. */
  async localContext(): Promise<z.infer<typeof contextSchema>> {
    const local = await this.local();
    if (!local) fail('local_required', 'This folder is not set up to save articles locally. Run supportpages init.');
    return { local: true, project: { name: path.basename(this.ws.root) }, supported_bundle_versions: [1], sections: [], articles: [],
      product_context: {}, inventory_truncated: false, writing_style: composeWritingStyle(local.writing_style) };
  }
  async contextFor(destination: 'hosted' | 'local' | 'none') {
    return destination === 'local' ? this.localContext() : this.context();
  }
  async binding(): Promise<Binding> {
    if (!await this.ws.exists(`${this.stateRoot}/binding.json`) && await this.ws.exists(`${this.stateRoot}/local.json`)) {
      fail('local_workspace', 'This folder saves articles locally and has no help centre. Run supportpages publish in the terminal to sign in and host them.');
    }
    const binding = parse(bindingSchema, await this.ws.json(`${this.stateRoot}/binding.json`));
    if (binding.api_origin !== this.api.origin) fail('destination_mismatch', 'This workspace is bound to a different API origin. Rebind it deliberately before continuing.');
    return binding;
  }
  /** Plugin installs download Chromium in the background when a session starts
   * (scripts/plugin-session.mjs). Say so, rather than failing mid-render. */
  private async requirePluginRenderer() {
    const scripts = new URL('../scripts/', import.meta.url);
    const { rendererReady } = await import(new URL('lib/renderer.mjs', scripts).href);
    const { command } = await import(new URL('lib/install.mjs', scripts).href);
    const quiet = (cmd: string, args: string[], options = {}) => command(cmd, args, { ...options, capture: true });
    if (await rendererReady(this.skillsDir, quiet)) return;
    const session = await import(new URL('plugin-session.mjs', scripts).href);
    await session.startDownload();
    fail('renderer_downloading', 'Chromium for article screenshots is still downloading; the first download takes a few minutes. Wait a minute, then prepare the article again.');
  }
  async version() { try { return (await readFile(path.join(this.skillsDir, 'VERSION'), 'utf8')).trim(); } catch { return 'unknown'; } }
  async doctor() {
    const dependencies = await Promise.all(['node', 'git'].map(async command => {
      try { const result = await exec(command === 'node' ? process.execPath : command, ['--version'], { timeout: 5000 }); return { command, available: true, version: result.stdout.trim() }; }
      catch { return { command, available: false }; }
    }));
    const skill = path.join(this.skillsDir, 'generate-illustrated-article', 'SKILL.md');
    let installed = false;
    try { installed = (await stat(skill)).isFile(); } catch { /* reported below */ }
    let telemetry: unknown = { enabled: false, reason: 'not_configured' };
    try { telemetry = await activeTelemetry()?.status() ?? telemetry; } catch { /* Doctor still reports the rest. */ }
    return { workspace: this.ws.root, api_origin: this.api.origin, dev_mode: this.api.dev, state_directory: this.stateRoot, credentials_configured: this.api.configured(), skills_path: this.skillsDir, skills_version: await this.version(), skills_installed: installed, dependencies, telemetry,
      notes: ['Generation runs in the host agent. This server does not launch a model.', 'Article rendering also needs Chromium, which supportpages setup downloads on first use, and any project-specific CSS dependencies.'] };
  }
  listProjects() { return this.api.request('GET', '/projects'); }
  async status(runId?: string) {
    const article_run = await this.runs.progress(runId);
    const analysis = await this.setup.analysis();
    const destination = await this.destination();
    const base = { workspace: this.ws.root, api_origin: this.api.origin, dev_mode: this.api.dev,
      credentials_configured: this.api.configured(), article_run, analysis, setup_task: await this.setup.progress(), generation_ready: false };
    if (destination === 'local') {
      const local = (await this.local())!;
      return { ...base, status: 'local', export_dir: local.export_dir, writing_style: local.writing_style, generation_ready: analysis.status === 'ready',
        instructions: [analysisInstruction(analysis),
          'This folder saves articles locally as Markdown and screenshots; no help centre is linked and no sign-in is needed, so do not start sign-in on your own. If the user asks to host the saved articles or to use a help centre, ask whether to sign in or create a free SupportPages.io account, then call supportpages_init with host_local=true (signup=true for a new account); use supportpages_publish instead when the saved articles should be uploaded as well.'].filter(Boolean).join(' ') };
    }
    // A folder that has never been set up has not chosen where its articles go.
    // Saving them here needs no account, so this is a setup step, not a sign-in
    // problem; only a folder already linked to a help centre needs a credential.
    if (destination === 'none' && !this.api.configured()) return { ...base, status: 'setup_required',
      instructions: 'This folder is not set up yet and no account is needed to set it up. It can save articles in the project as Markdown and screenshots with no sign-in, or publish them to a SupportPages.io help centre for a public URL, editor review and AI answers. Do not start sign-in on your own and do not present hosting as required: ask which the user wants, then call supportpages_init (signup=true only when they chose to create a new account).' };
    if (!this.api.configured()) return { ...base, status: 'authentication_required', instructions: 'This device is not signed in. Do not start sign-in on your own: if the user wants to host articles or read the hosted help centre, ask whether to sign in or create a free SupportPages.io account, then call supportpages_init (signup=true for a new account) to open browser approval.' };
    try {
      const response = z.object({ projects: z.array(z.object({ id: remoteId, name: z.string().max(500), help_centre_url: z.url().optional(), repository_connection: contextSchema.shape.repository_connection })) }).safeParse(await this.listProjects());
      if (!response.success) fail('invalid_response', 'The API returned an invalid project list.');
      if (!await this.ws.exists(`${this.stateRoot}/binding.json`)) return { ...base, status: 'project_required',
        projects: response.data.projects, instructions: 'Signed in, but this folder has not chosen where its articles go. Hosting is not required: it can also save them in the project as Markdown and screenshots. Ask which the user wants, then call supportpages_init with that project_id for a help centre (or supportpages_create_project first), or supportpages_init alone to set the folder up to save locally.' };
      const binding = await this.binding();
      const project = response.data.projects.find(project => project.id === binding.project_id);
      if (!project) return { ...base, status: 'project_unavailable', project_id: binding.project_id,
        instructions: 'The signed-in account cannot access the help centre this folder is linked to. Restore access, or call supportpages_init with another project_id to link a different help centre.' };
      const action = project.repository_connection?.writer?.actions.create_article;
      const hosted_operation = await this.hosted.get(undefined,0,false);
      const next = action ? action.next_step?.message ?? (action.execution === 'local' ? analysisInstruction(analysis) : undefined) : analysisInstruction(analysis);
      return { ...base, status: 'ready', project_id: project.id, project, repository_connection: project.repository_connection,
        hosted_operation, generation_ready: action ? action.allowed && (action.execution !== 'local' || analysis.status === 'ready') : analysis.status === 'ready', writer_action: action, ...(next ? { instructions: next } : {}) };
    } catch (error) {
      const safe = publicError(error);
      return { ...base, status: safe.code === 'invalid_credentials' ? 'authentication_required' : 'connection_error',
        error: safe, instructions: safe.code === 'invalid_credentials'
          ? 'The device sign-in is expired or revoked. Ask before calling supportpages_init to sign in again.'
          : 'Check the reported connection error and retry supportpages_status.' };
    }
  }
  createProject(name: string, subdomain: string) { return this.api.request('POST', '/projects', { name, subdomain }); }
  async bind(projectId: string, options: { requireIdle?: boolean } = {}) {
    parse(remoteId, projectId);
    const context = parse(contextSchema, await this.api.request('GET', `/projects/${projectId}/context`), 'invalid_response');
    if (context.project.id !== projectId) fail('invalid_response', 'Project identity mismatch.');
    return this.lock(async () => {
      if (options.requireIdle) await this.runs.assertAvailable();
      if (await this.ws.exists(`${this.stateRoot}/binding.json`)) {
        const old = parse(bindingSchema, await this.ws.json(`${this.stateRoot}/binding.json`));
        if (old.project_id !== projectId || old.api_origin !== this.api.origin) fail('destination_mismatch', 'This workspace is already bound to another destination. Use a separate workspace or archive .rtfm/supportpages before rebinding.');
      }
      const binding: Binding = { version: 1, project_id: projectId, api_origin: this.api.origin };
      const fresh = !await this.ws.exists(`${this.stateRoot}/binding.json`);
      await this.ws.writeJson(`${this.stateRoot}/binding.json`, binding);
      if (fresh) track('project_init', { location: 'hosted' });
      return { ...binding, project: context.project };
    });
  }
  async context() {
    const binding = await this.binding();
    return parse(contextSchema, await this.api.request('GET', `/projects/${binding.project_id}/context`), 'invalid_response');
  }
  /** Recover a confirmed link from local journals without requiring a working API. */
  async articleErrorContext(input: { run_id?: unknown; title?: unknown; artifact_dir?: unknown }) {
    const binding = await this.ws.exists(`${this.stateRoot}/binding.json`) ? await this.binding() : undefined;
    const belongs = (run: Run) => run.project_id === binding?.project_id && run.api_origin === binding?.api_origin;
    let run: Run | undefined;
    if (z.uuid().safeParse(input.run_id).success) run = await this.runs.read(input.run_id as string);
    else {
      const artifact = typeof input.artifact_dir === 'string' ? input.artifact_dir : typeof input.title === 'string'
        ? `output/articles/${input.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}` : undefined;
      if (!artifact) return;
      for (const entry of await this.ws.list(`${this.stateRoot}/runs`)) {
        if (!entry.isDirectory() || !z.uuid().safeParse(entry.name).success) continue;
        let candidate: Run;
        try { candidate = await this.runs.read(entry.name); } catch { continue; }
        if (belongs(candidate) && (candidate.artifact_dir === artifact || typeof input.title === 'string' && candidate.title === input.title) && (!run || candidate.started_at > run.started_at)) run = candidate;
      }
    }
    if (!run || !belongs(run)) return;
    return { run_id: run.id, title: run.title, phase: run.phase, ...articleLink(run),
      recovery: `Inspect this same run with supportpages_status (run_id=${run.id}). If its writer stopped before finishing, use supportpages_retry_article; if it finished locally, retry supportpages_complete_article. Respect run_closed or revision_conflict and review the article in the browser instead of restarting it. Do not prepare a duplicate article.` };
  }
  async prepare(input: { title: string; description?: string; article_type: z.infer<typeof articleType>; section_id?: string; prefer_background?: boolean; open_when_ready?: boolean; allow_duplicate?: boolean }) {
    requireExecution(await resolveAction(this, 'create_article'), 'local');
    const destination = await this.destination();
    const context = await this.contextFor(destination);
    const local = context.local ? (await this.local())! : undefined;
    if (!context.local) checkArticleCapacity(context.article_capacity);
    if (input.section_id && context.local) fail('invalid_section', 'This folder saves articles locally and has no sections.');
    if (input.section_id && context.repository_connection?.capabilities.sections === false) {
      fail('repository_connection_required', `Connect a repository before assigning sections: ${context.repository_connection.connect_url}`);
    }
    const savedPreferences = local ? { ...defaultPreferences, ...local.preferences } : await preferences(this.api);
    const writerModel = (await executionSettings(this, 'claude')).model;
    const codexWriter = await executionSettings(this, 'codex');
    if (!context.supported_bundle_versions.includes(1)) fail('unsupported_schema', 'The remote server does not support bundle version 1.');
    if (input.section_id && !context.sections.some(s => s.id === input.section_id)) fail('invalid_section', 'Select a section belonging to the bound project.');
    const slug = input.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (!slug || slug.length > 120) fail('invalid_title', 'Use a title that produces a nonempty ASCII slug of at most 120 characters.');
    try { await stat(path.join(this.skillsDir, 'generate-illustrated-article', 'SKILL.md')); } catch { fail('missing_dependency', 'The article engine is missing from this installation. Reinstall SupportPages Writer, or point RTFM_SKILLS_DIR at an engine directory.'); }
    if (pluginName) await this.requirePluginRenderer();
    return this.lock(async () => {
      if (!context.local) {
        const synced = await new ProjectSync(this).refresh(context, false);
        if (synced.status === 'ready' && !input.allow_duplicate) {
          const duplicate = synced.articles.find(item => item.remote?.deleted_at === null && item.remote.title.trim().toLowerCase() === input.title.trim().toLowerCase());
          if (duplicate?.remote && 'editor_url' in duplicate.remote) fail('article_exists', 'An article with this title already exists in this help centre. Review it in the editor. Create another only if the user explicitly wants a separate article.', { editor_url: duplicate.remote.editor_url, article_id: duplicate.remote.id });
        }
      }
      await this.runs.assertAvailable();
      if (context.local ? await this.destination() !== 'local' : (await this.binding()).project_id !== context.project.id) fail('destination_mismatch', 'The connected help centre changed while preparing this article. Start again with the current connection.');
      const analysis = await this.setup.requireAnalysis();
      const scope = createHash('sha256').update(`${this.api.dev}\n${this.api.origin}`).digest('hex').slice(0, 16);
      const articleSlug = input.allow_duplicate ? `${slug.slice(0, 100)}-${randomUUID().slice(0, 8)}` : slug;
      const artifactDir = `${this.stateRoot}/work/${context.local ? 'local' : context.project.id}/${articleSlug}`;
      // Keep earlier outputs retryable in place, and do not start a second writer
      // for a topic just because new runs now use the private working directory.
      const previousDirs = local ? [`output/articles/${articleSlug}`, path.posix.join(local.export_dir, articleSlug)]
        : [`output/articles/${scope}-${context.project.id}/${articleSlug}`, `output/articles/${articleSlug}`];
      for (const directory of [artifactDir, ...previousDirs]) {
        if (await this.ws.exists(directory)) fail('output_exists', 'Work for this topic already exists. Check the existing article status and continue that article instead of starting a duplicate.');
      }
      const run = { writer_token: randomUUID(), codebase_dir: analysis.codebase_dir, id: randomUUID(), local_article_id: randomUUID(), artifact_dir: artifactDir, started_at: new Date().toISOString(), section_id: input.section_id ?? null, article_type: input.article_type, ...(context.progressive_articles ? { progress: { attempt: randomUUID(), sequence: 0 } } : {}), status: 'prepared' as const, skills_version: await this.version(), title: input.title, ...(local ? { local_export: { directory: local.export_dir } } : { api_origin: this.api.origin, project_id: context.project.id }), prefer_background: input.prefer_background ?? savedPreferences.prefer_background, open_when_ready: input.open_when_ready ?? savedPreferences.open_when_ready, phase: 'prepared' as const, session_id: this.sessionId };
      const writerWorkspace = await this.ws.resolve(analysis.codebase_dir);
      const outputPath = await this.ws.resolve(artifactDir);
      const writerArtifactDir = analysis.codebase_dir === '.' ? artifactDir : outputPath;
      const contextFile = await this.ws.writeJson(`${this.stateRoot}/runs/${run.id}/context.json`, { ...context, project_overview: analysis.overview, analysis_summary: analysis.summary, project_name: context.project.name, article_title: input.title, article_description: input.description ?? '', article_type: input.article_type });
      await this.ws.writeJson(`${this.stateRoot}/runs/${run.id}/run.json`, run);
      await this.ws.writeJson(`${this.stateRoot}/active-run.json`, run);
      // Reserve a preview before handing off to the host, including foreground writers.
      // A lost response is recoverable through this same idempotent run ID.
      if (run.progress) {
        await this.relay.ensureStartedUnlocked(run.id);
      }
      this.relay.start(run.id);
      const link = articleLink(await this.runs.read(run.id));
      const entrypoint = writerEntry(this.ws.root, this.stateRoot, run.id, this.skillsDir, run.writer_token);
      const environment = { RTFM_WORKSPACE: writerWorkspace, RTFM_CONTEXT_FILE: contextFile, RTFM_OUTPUT_DIR: outputPath, RTFM_SKILLS_DIR: this.skillsDir, RTFM_MAX_IMAGES: String(writerScreenshotLimit), PATH: path.dirname(process.execPath) + path.delimiter + (process.env.PATH ?? '') };
      const savedTo = local ? path.posix.join(local.export_dir, articleSlug) : undefined;
      return { status: 'prepared', run_id: run.id, artifact_dir: artifactDir, environment, ...link,
        ...(local ? { local: true, saved_to: savedTo, link_message: `The article will be saved to ${savedTo}.`, link_instructions: localChatInstruction } : {}),
        prefer_background: run.prefer_background, open_when_ready: run.open_when_ready,
        task_brief: { name: writerAgentName, claude_model: writerModel, codex_model: codexWriter.model, codex_reasoning_effort: codexWriter.effort,
          prefer_background: run.prefer_background, reporting_instructions: writerReportingInstruction(run.prefer_background === true),
          writer_instructions: claudeWriterAgents[writerAgentType].prompt, workspace: writerWorkspace, run_id: run.id, artifact_dir: writerArtifactDir,
          environment, entrypoint, execution: entrypoint.execution, completion: entrypoint.completion, editor_url: link.editor_url,
          instructions: [entrypoint.instruction, entrypoint.execution.instruction,
            `The application and its .rtfm cache are in ${writerWorkspace}. Use ${outputPath} as OUT for every skill command instead of the default ./output/articles directory. Keep all article artifacts there so the MCP can observe and upload them.`,
            `Read ${path.join(this.skillsDir, 'detect-project', 'SKILL.md')} and run detect-project if the project map is missing, stale, or reports an incomplete detection or a wrong app_type. An incomplete map names the app type it needs (app_type=…): rerun detection with that app type before generating, and report the block if it cannot be resolved.`,
            'Generate the requested article using the instructions returned by the entry check and the supplied context and environment.',
            'Finish all images, final rendering and fidelity validation. Do not edit application source code.',
            entrypoint.completion.instruction,
            writerPermissionInstruction,
            'Report success only after the full pipeline finishes. Report unresolved failures to the main agent. Do not call MCP tools, upload or publish.'] },
        instructions: [
          local ? localChatInstruction : link.link_instructions,
          writerLaunchInstruction,
          codexWriterLaunchInstruction,
          backgroundParentInstruction,
          'Keep this run ID and task brief in the main conversation. Use the current host agent, not a separate agent CLI or paid runner.',
          'Use the existing application directory in task_brief.workspace. Do not request worktree isolation or create a new checkout for this writer: it needs the existing .rtfm cache and tracked output directory. Background execution does not require a worktree. If the host cannot launch without one, use the foreground with this same prepared run.',
          run.prefer_background ? 'Launch the task brief with the host’s native background task facility. If unavailable or permission-blocked, explain briefly and execute it in the foreground. Stop any failed background writer before foreground retry.' : 'Run the task brief in the foreground.',
          'Only after launch succeeds, call supportpages_update_run with event=started, execution_mode and the host_task_id when available. A prepared run is not yet writing. The writer entrypoint independently records actual startup and enables live previews, so a missed host update does not interrupt delivery.',
          'Preserve and inspect the host task completion result. Stay available for approvals and recovery until the writer finishes or needs user intervention. If delegation cannot support approvals, stop the writer and use foreground recovery with the same permissions. Do not leave a stopped run falsely marked writing.',
          ...(local ? [
            'On successful host completion, call supportpages_complete_article with this run_id and completed=true, even if the writer finish command already reported the article as saved. It returns the saved Markdown path; show that path as the deliverable. If the finish command reports delivery_pending, retry complete_article without regenerating or marking the writer failed. On writing failure or interruption, report it with supportpages_update_run and stopped=true only after confirming the writer stopped.',
            'This folder has no help centre: never ask whether to publish automatically. Only if the user explicitly asks to host or publish saved articles, call supportpages_publish; otherwise never start browser sign-in or call upload or publish tools. Any hosting offer comes from complete_article as hosting_invitation; do not add your own.',
            'Never finalize a failed, interrupted, or partial run. No preview link exists for local articles.',
          ] : [
            'On successful host completion, call supportpages_complete_article with this run_id and completed=true to obtain the delivery instructions, even if the writer finish command already delivered the draft. Do not claim the article is ready or ask to publish until delivery is confirmed. If the finish command reports delivery_pending or upload_failed, retry complete_article without regenerating or marking the writer failed. On writing failure or interruption, report it with supportpages_update_run and stopped=true only after confirming the writer stopped.',
            'Return the completed editor link and ask: Would you like me to publish it? No answer or a refusal leaves a draft. Opening the browser is not publication consent.',
            'Never finalize a failed, interrupted, or partial run. The MCP relay uploads read-only preview milestones automatically; show the preview link returned by update_run. It handles early browser opening when enabled.',
          ]) ],
        writer_entrypoint: entrypoint };
    });
  }
  async updateRun(input: { run_id: string; event: 'started' | 'failed' | 'interrupted' | 'cancelled'; execution_mode?: 'foreground' | 'background'; host_task_id?: string; stopped?: boolean }) {
    return this.lock(async () => {
      const run = await this.runs.read(input.run_id);
      if (run.status !== 'prepared') fail('invalid_run', 'Only a prepared or writing run can receive host execution updates.');
      if (input.event === 'started') {
        if (!input.execution_mode) fail('invalid_run', 'Report the actual execution mode after successfully starting the writer.');
        if (run.phase === 'writing' && run.execution_mode !== undefined && (run.execution_mode !== input.execution_mode || (input.host_task_id && input.host_task_id !== run.host_task_id)) && !input.stopped) fail('writer_not_stopped', 'Confirm stopped=true before replacing the current writer.');
        await this.runs.assertAvailable(run.id);
        await this.runs.save({ ...run, phase: 'writing', session_id: this.sessionId, first_writer_started_at: run.first_writer_started_at ?? new Date().toISOString(),
          execution_mode: input.execution_mode, host_task_id: input.host_task_id ?? (input.execution_mode === run.execution_mode ? run.host_task_id : undefined), error: undefined });
        if (run.progress) {
          try { await this.relay.ensureStartedUnlocked(run.id); }
          catch (error) { await this.runs.save({ ...(await this.runs.read(run.id)), progress: { ...run.progress, sync_error: publicError(error).message } }); }
          this.relay.start(run.id);
        }
      } else {
        if (!input.stopped) fail('writer_not_stopped', 'Stop the host task and confirm stopped=true before releasing this run.');
        this.relay.stop();
        await this.reportProgressEvent(run, input.event);
        await this.runs.save({ ...(await this.runs.read(run.id)), status: input.event, phase: input.event });
        trackArticle(run, input.event);
      }
      return this.runs.progress(run.id);
    });
  }
  async cancel(runId: string, stopped = false, expectedRun?: Run) {
    return this.lock(async () => {
      const run = await this.runs.read(runId);
      if (expectedRun && JSON.stringify(run) !== JSON.stringify(expectedRun)) fail('run_changed', 'The article run changed while you were reviewing it. Check its latest progress before clearing it.');
      if (run.status !== 'prepared') fail('invalid_run', 'Only a prepared or writing run can be cancelled.');
      if (run.phase === 'writing' && !stopped) fail('writer_not_stopped', 'Stop the host writer, then call cancel_run with stopped=true.');
      this.relay.stop();
      await this.reportProgressEvent(run, 'cancelled');
      await this.runs.save({ ...(await this.runs.read(run.id)), status: 'cancelled', phase: 'cancelled' });
      trackArticle(run, 'cancelled');
      return { status: 'cancelled', ...articleLink(run), note: 'Run bookkeeping released. The server does not stop the host agent or delete its output.' };
    });
  }
  async validate(dir: string) {
    const snap = await snapshot(this.ws, dir);
    return { valid: true, title: snap.article.title, blocks: snap.article.blocks.length, images: snap.images.length, warnings: snap.warnings, finalized: false };
  }
  async preview(dir: string) {
    const snap = await snapshot(this.ws, dir);
    const file = await this.ws.write(`${this.stateRoot}/previews/${randomUUID()}.html`, preview(snap));
    return { path: file, uri: pathToFileURL(file).href, title: snap.article.title, warnings: snap.warnings };
  }
  async finalize(input: { artifact_dir: string; completed: true; run_id?: string; section_id?: string }) {
    if (!input.completed) fail('incomplete_generation', 'Finalize only after the entire generation pipeline succeeds.');
    return this.lock(() => this.finalizeUnlocked(input));
  }
  private async finalizeUnlocked(input: { artifact_dir: string; completed: true; run_id?: string; section_id?: string }) {
      await this.ws.resolve(input.artifact_dir);
      const legacy = /^output\/articles\/(?:([a-f0-9]{16}-[1-9][0-9]*)\/)?[a-z0-9]+(?:-[a-z0-9]+)*$/.exec(input.artifact_dir);
      const working = /^(\.rtfm\/supportpages(?:\/dev\/[a-f0-9]{16})?)\/work\/(local|[1-9][0-9]*)\/[a-z0-9]+(?:-[a-z0-9]+)*$/.exec(input.artifact_dir);
      if (!legacy && !working) fail('invalid_path', 'Finalize an article output directory returned by SupportPages.io.');
      const scope = createHash('sha256').update(`${this.api.dev}\n${this.api.origin}`).digest('hex').slice(0, 16);
      if ((legacy?.[1] && legacy[1] !== `${scope}-${(await this.binding()).project_id}`) ||
          (working && (working[1] !== this.stateRoot || (working[2] === 'local'
            ? await this.destination() !== 'local' : working[2] !== (await this.binding()).project_id)))) {
        fail('destination_mismatch', 'These article outputs belong to a different help centre.');
      }
      let run: z.infer<typeof runSchema> | undefined;
      if (await this.ws.exists(`${this.stateRoot}/active-run.json`)) {
        const pointer = parse(runSchema, await this.ws.json(`${this.stateRoot}/active-run.json`));
        const active = await this.ws.exists(`${this.stateRoot}/runs/${pointer.id}/run.json`) ? await this.runs.read(pointer.id) : pointer;
        if (active.status === 'prepared') {
          if (input.run_id !== active.id || input.artifact_dir !== active.artifact_dir) fail('invalid_run', 'The active generation must be finalized with its matching run ID and output directory.');
          run = active;
        }
      }
      if (input.run_id && !run) fail('invalid_run', 'This generation run is not active.');
      await this.runs.assertAvailable(input.run_id);
      if (!run) await this.setup.requireAnalysis();
      if (run && input.section_id && input.section_id !== run.section_id) fail('invalid_section', 'The section differs from the prepared generation context.');
      const snap = await snapshot(this.ws, input.artifact_dir, run?.started_at);
      const key = input.artifact_dir.split('/').at(-1)!;
      const old = await this.ws.exists(`${this.stateRoot}/articles/${key}.json`) ? parse(localSchema, await this.ws.json(`${this.stateRoot}/articles/${key}.json`)) : undefined;
      const destination = await this.ws.exists(`${this.stateRoot}/binding.json`) ? await this.binding() : undefined;
      if (old?.project_id && (old.project_id !== destination?.project_id || old.api_origin !== destination?.api_origin)) fail('destination_mismatch', 'This saved article belongs to another help centre.');
      let commit: string | null = null, dirty = true;
      const sourceWorkspace = run?.codebase_dir ? await this.ws.resolve(run.codebase_dir) : this.ws.root;
      try {
        commit = (await exec('git', ['rev-parse', 'HEAD'], { cwd: sourceWorkspace, timeout: 5000 })).stdout.trim();
        dirty = Boolean((await exec('git', ['status', '--porcelain', '--untracked-files=normal', '--', '.', ':!output', ':!.rtfm', ':!.rtfm-trace'], { cwd: sourceWorkspace, timeout: 5000 })).stdout.trim());
      } catch { /* non-git workspaces retain unknown/dirty provenance */ }
      if (this.source) { commit = this.source.source_commit; dirty = this.source.source_dirty; }
      const previousManifest = old ? parse(manifestSchema, await this.ws.json(`${old.bundle_dir}/manifest.json`)) : undefined;
      const manifest = createManifest(snap, { local_article_id: old?.local_article_id ?? run?.local_article_id ?? randomUUID(), run_id: run?.id ?? randomUUID(), skills_version: run?.skills_version ?? await this.version(), source_commit: commit, source_dirty: dirty, section_id: run ? run.section_id : input.section_id ?? previousManifest?.section_id ?? null });
      const bundleDir = `${this.stateRoot}/bundles/${manifest.bundle_hash}`;
      await this.ws.write(`${bundleDir}/article.json`, snap.articleBytes);
      for (const image of snap.images) await this.ws.write(`${bundleDir}/${image.filename}`, image.bytes);
      await this.ws.writeJson(`${bundleDir}/manifest.json`, manifest);
      const state = { ...(destination ? { project_id: destination.project_id, api_origin: destination.api_origin } : {}), local_article_id: manifest.local_article_id, artifact_dir: input.artifact_dir, bundle_dir: bundleDir, bundle_hash: manifest.bundle_hash, ...(old?.remote ? { remote: old.remote, uploaded_bundle_hash: old.uploaded_bundle_hash } : run?.progress?.article ? { remote: run.progress.article } : {}) };
      await this.ws.writeJson(`${this.stateRoot}/articles/${key}.json`, state);
      if (run) {
        await this.runs.save({ ...run, status: 'finalized', phase: 'finalizing', bundle_dir: bundleDir, bundle_hash: manifest.bundle_hash, error: undefined });
      }
      return { status: 'finalized', ...state, warnings: snap.warnings };
  }
  /** Saved local articles, newest first: state files without a help centre plus their run titles. */
  async localArticles() {
    const items: { slug: string; title: string; local_article_id: string; artifact_dir: string; export_path?: string; run_id?: string }[] = [];
    for (const entry of await this.ws.list(`${this.stateRoot}/articles`)) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const state = localSchema.safeParse(await this.ws.json(`${this.stateRoot}/articles/${entry.name}`));
      if (!state.success || state.data.project_id) continue;
      let title = entry.name.slice(0, -5);
      try { title = (await this.ws.json(`${state.data.bundle_dir}/article.json`) as { title?: string }).title ?? title; } catch { /* Bundle removed; keep the slug. */ }
      let run: Run | undefined;
      try {
        const manifest = parse(manifestSchema, await this.ws.json(`${state.data.bundle_dir}/manifest.json`));
        if (await this.ws.exists(`${this.stateRoot}/runs/${manifest.run_id}/run.json`)) run = await this.runs.read(manifest.run_id);
      } catch { /* A missing manifest still leaves an uploadable state file. */ }
      items.push({ slug: entry.name.slice(0, -5), title, local_article_id: state.data.local_article_id, artifact_dir: state.data.artifact_dir, export_path: run?.export_path, run_id: run?.id });
    }
    return items.sort((a, b) => a.title.localeCompare(b.title));
  }
  async listLocal() {
    if (!this.api.configured() || await this.destination() === 'local') return localArticleInventory(this);
    return this.lock(async () => {
      const sync = new ProjectSync(this);
      const result = await sync.refresh();
      return result.status === 'ready' ? result : { ...result, articles: await sync.localRecords() };
    });
  }
  async upload(slug: string) {
    return this.lock(() => this.uploadUnlocked(slug));
  }
  /** Shared CLI/MCP saved-article upload; the lock keeps the destination stable for the batch. */
  async uploadLocalArticles(slugs?: string[], onEvent?: (event: {
    slug: string; title: string; editor_url?: string; error?: ReturnType<typeof publicError>;
  }) => void) {
    return this.lock(async () => {
      await this.runs.assertAvailable();
      const binding = await this.binding();
      const articles = await this.localArticles();
      if (!slugs) return { status: articles.length ? 'selection_required' : 'up_to_date', project_id: binding.project_id, articles,
        instructions: 'Choose the saved articles to upload as drafts, then call supportpages_publish with their slugs. This folder is now linked to this help centre. Public publication is a separate action.' };
      const selected = [];
      const already_uploaded: { slug: string; editor_url: string }[] = [];
      // Validate the entire selection before sending any article.
      for (const slug of new Set(slugs)) {
        parse(idSchema, slug, 'invalid_article');
        const item = articles.find(article => article.slug === slug);
        if (item) { selected.push(item); continue; }
        const file = `${this.stateRoot}/articles/${slug}.json`;
        const state = await this.ws.exists(file) ? parse(localSchema, await this.ws.json(file)) : undefined;
        if (state?.project_id === binding.project_id && state.api_origin === binding.api_origin && state.remote && state.uploaded_bundle_hash === state.bundle_hash) {
          already_uploaded.push({ slug, editor_url: state.remote.editor_url });
        } else fail('invalid_article', 'Choose an article from the saved local article list.', { slug });
      }
      const uploaded: { slug: string; title: string; editor_url: string }[] = [];
      const failed: { slug: string; title: string; error: ReturnType<typeof publicError> }[] = [];
      let stopped = false;
      const skipped: string[] = [];
      for (const item of selected) {
        if (stopped) { skipped.push(item.slug); continue; }
        onEvent?.({ slug: item.slug, title: item.title });
        try {
          const result = await this.uploadUnlocked(item.slug);
          const saved = { slug: item.slug, title: item.title, editor_url: result.article.editor_url };
          uploaded.push(saved); onEvent?.(saved);
        } catch (error) {
          const problem = { slug: item.slug, title: item.title, error: publicError(error) };
          failed.push(problem); onEvent?.(problem);
          stopped = problem.error.code === 'plan_limit';
        }
      }
      return { status: failed.length ? 'upload_incomplete' : 'drafts_uploaded', project_id: binding.project_id,
        uploaded, already_uploaded, failed, skipped,
        instructions: 'Show the editor links for uploaded drafts and any errors. Resolve upload failures and retry supportpages_publish without regenerating. Articles remain drafts; review them in SupportPages.io. This folder now sends new articles to this help centre.' };
    });
  }
  private async uploadUnlocked(slug: string) {
      const binding = await this.binding();
      const stateFile = `${this.stateRoot}/articles/${slug}.json`;
      const state = parse(localSchema, await this.ws.json(stateFile));
      if (state.project_id && (state.project_id !== binding.project_id || state.api_origin !== binding.api_origin)) fail('destination_mismatch', 'This saved article belongs to another help centre.');
      await new ProjectSync(this).guard(state.local_article_id);
      const { manifest, snap } = await verifyBundle(this.ws, state.bundle_dir);
      const run = await this.ws.exists(`${this.stateRoot}/runs/${manifest.run_id}/run.json`) ? await this.runs.read(manifest.run_id) : undefined;
      if (run?.project_id && (run.project_id !== binding.project_id || run.api_origin !== binding.api_origin)) fail('destination_mismatch', 'The run belongs to a different help centre.');
      const form = new FormData();
      form.set('manifest', JSON.stringify(manifest));
      form.set('article', new Blob([new Uint8Array(snap.articleBytes)], { type: 'application/json' }), 'article.json');
      for (const image of snap.images) form.set(`images[${image.block_id}]`, new Blob([new Uint8Array(image.bytes)], { type: 'image/png' }), image.filename);
      if (run?.progress?.article) form.set('generation_attempt', run.progress.attempt);
      const destination = run?.progress?.article ?? state.remote;
      if (destination) { form.set('article_id', destination.id); form.set('expected_revision', destination.revision); }
      const result = parse(importResponseSchema, await this.api.request('POST', `/projects/${binding.project_id}/article_imports`, form, manifest.bundle_hash), 'invalid_response');
      // An article written before this folder had a help centre now belongs to it.
      const adopted = { project_id: binding.project_id, api_origin: binding.api_origin };
      await this.ws.writeJson(stateFile, { ...state, ...adopted, remote: result.article, uploaded_bundle_hash: manifest.bundle_hash });
      if (run) await this.runs.save({ ...run, ...adopted, phase: 'ready_for_review', remote: result.article, error: undefined });
      return result;
  }
  async complete(input: { run_id: string; completed: true }, options: { deliver?: boolean } = {}) {
    if (!input.completed) fail('incomplete_generation', 'Confirm successful completion of the entire writing task.');
    this.relay.stop();
    return this.lock(async () => {
      let run = await this.runs.read(input.run_id);
      if (!['prepared', 'finalized'].includes(run.status)) fail('incomplete_generation', 'Failed, cancelled or interrupted runs cannot be delivered.');
      if (!run.project_id) return this.completeLocallyUnlocked(run, options.deliver !== false);
      const binding = await this.binding();
      if (run.project_id && (run.project_id !== binding.project_id || run.api_origin !== binding.api_origin)) fail('destination_mismatch', 'The run belongs to a different help centre.');
      const slug = run.artifact_dir.split('/').at(-1)!;
      if (run.remote) {
        const synced = await new ProjectSync(this).refresh(undefined, false);
        const item = synced.status === 'ready' ? synced.articles.find(item => item.remote?.id === run.remote!.id) : undefined;
        if (item?.sync_status === 'deleted_remotely') fail('article_deleted', 'This article was deleted remotely. Restore it in SupportPages.io before continuing.');
        if (item?.sync_status === 'unavailable') fail('article_unavailable', 'The article is unavailable. Check its project and access.');
        const delivered = item?.remote && 'revision' in item.remote ? { ...run, remote: item.remote } : run;
        return options.deliver === false ? { status: 'ready_for_review', editor_url: delivered.remote!.editor_url } : this.delivery(delivered);
      }
      try {
        await new ProjectSync(this).guard(run.local_article_id);
        if (run.status === 'prepared') {
          await this.runs.save({ ...run, phase: 'finalizing', error: undefined });
          await this.finalizeUnlocked({ artifact_dir: run.artifact_dir, run_id: run.id, completed: true });
          run = await this.runs.read(run.id);
        }
        if (run.progress) {
          await this.relay.ensureStartedUnlocked(run.id);
          await this.relay.sendPendingUnlocked(run.id);
          run = await this.runs.read(run.id);
        }
        const state = parse(localSchema, await this.ws.json(`${this.stateRoot}/articles/${slug}.json`));
        const { manifest } = await verifyBundle(this.ws, state.bundle_dir);
        if (manifest.run_id !== run.id || state.local_article_id !== run.local_article_id || (run.bundle_hash && state.bundle_hash !== run.bundle_hash)) fail('stale_artifact', 'This run’s finalized article was replaced. Do not upload a different revision.');
        await this.runs.save({ ...run, phase: 'uploading', error: undefined });
        // Reconcile a previous upload that saved article state before run state.
        if (state.remote && state.uploaded_bundle_hash === state.bundle_hash) {
          await this.runs.save({ ...run, phase: 'ready_for_review', remote: state.remote });
        } else await this.uploadUnlocked(slug);
        const delivered = await this.runs.read(run.id);
        trackArticle(delivered, 'succeeded');
        return options.deliver === false ? { status: 'ready_for_review', editor_url: delivered.remote!.editor_url } : this.delivery(delivered);
      } catch (error) {
        const safe = publicError(error);
        const current = await this.runs.read(run.id);
        const phase = current.status === 'finalized' ? 'upload_failed' : 'failed';
        const failed = { ...current, phase: phase as Run['phase'], error: { code: safe.code, message: safe.message } };
        await this.runs.save(failed);
        trackArticle(current, phase, safe.code);
        if (phase === 'upload_failed') {
          const detail = safe.details && typeof safe.details === 'object' ? safe.details as Record<string, unknown> : {};
          fail(safe.code, `${safe.message} The article is generated, but delivery to the editor could not be confirmed. Retry delivery without regenerating it.`, {
            run_id: current.id, phase, generation_completed_locally: true,
            editor_url: detail.editor_url ?? current.progress?.article?.editor_url,
            remote_state: current.progress?.article ? 'preview_previously_confirmed' : 'unconfirmed',
            instructions: uploadRecovery(failed),
          });
        }
        throw error;
      }
    });
  }
  /** A run written without a help centre is finalized and exported instead of uploaded. Safe to repeat. */
  private async completeLocallyUnlocked(run: Run, deliver = true) {
    const local = await this.local();
    if (!local) fail('local_required', 'This article was written for local saving, but the folder no longer has local settings. Run supportpages init.');
    if (run.phase === 'saved' && run.export_path) return this.savedLocally(run, local, undefined, deliver);
    try {
      if (run.status === 'prepared') {
        await this.runs.save({ ...run, phase: 'finalizing', error: undefined });
        await this.finalizeUnlocked({ artifact_dir: run.artifact_dir, run_id: run.id, completed: true });
        run = await this.runs.read(run.id);
      }
      const slug = run.artifact_dir.split('/').at(-1)!;
      const state = parse(localSchema, await this.ws.json(`${this.stateRoot}/articles/${slug}.json`));
      const { manifest, snap } = await verifyBundle(this.ws, state.bundle_dir);
      if (manifest.run_id !== run.id || state.local_article_id !== run.local_article_id || (run.bundle_hash && state.bundle_hash !== run.bundle_hash)) fail('stale_artifact', 'This run’s finalized article was replaced. Complete the current article instead.');
      const directory = run.local_export?.directory ?? local.export_dir;
      const exported = await exportArticle(this.ws, snap, run.artifact_dir, directory, slug);
      run = { ...run, phase: 'saved', export_path: exported.markdown_path, local_export: { directory }, error: undefined };
      await this.runs.save(run);
      trackArticle(run, 'succeeded');
      return this.savedLocally(run, local, exported.image_count, deliver);
    } catch (error) {
      const safe = publicError(error);
      const current = await this.runs.read(run.id);
      // A finalized bundle whose export failed can be exported again; an
      // unfinished bundle is a failed writer.
      await this.runs.save({ ...current, phase: current.status === 'finalized' ? 'finalizing' : 'failed', error: { code: safe.code, message: safe.message } });
      trackArticle(current, 'failed', safe.code);
      throw error;
    }
  }
  private async savedLocally(run: Run, local: LocalSettings, imageCount?: number, deliver = true) {
    const slug = run.artifact_dir.split('/').at(-1)!;
    let preview_uri: string | undefined;
    try { preview_uri = (await this.preview(run.artifact_dir)).uri; } catch { /* The Markdown export is the deliverable. */ }
    const defaultFolder = (run.local_export?.directory ?? local.export_dir).replace(/\/+$/, '') === 'output/articles';
    // The relay's early completion leaves the one-time invitation for the
    // parent's complete_article call, like the hosted publication question.
    // A replay returns the invitation this article already got, so a repeated
    // complete_article call cannot lose it.
    let hosting_invitation: HostingInvitation | undefined = deliver && run.hosting_reminder_checked ? run.hosting_invitation : undefined;
    if (deliver && !run.hosting_reminder_checked) {
      try {
        // Mark this delivery checked even if the optional device journal fails.
        await this.runs.save({ ...run, hosting_reminder_checked: true });
        hosting_invitation = await new HostingReminders(this.configDir).complete({ origin: this.api.origin, articleId: run.local_article_id });
        if (hosting_invitation) await this.runs.save({ ...run, hosting_reminder_checked: true, hosting_invitation });
      } catch { hosting_invitation = undefined; /* Reminders must never turn a saved article into a failure. */ }
    }
    return { status: 'saved' as const, run_id: run.id, slug, artifact_dir: run.artifact_dir, markdown_path: run.export_path!,
      export_dir: path.dirname(run.export_path!), image_count: imageCount, preview_uri, ...articleLink(run), local: true,
      ...(hosting_invitation ? { hosting_invitation, show_to_user: hostingShowText(hosting_invitation) } : {}),
      instructions: [
        ...(hosting_invitation ? ['Show show_to_user verbatim as its own paragraph, right after the saved path. It is part of this result, not optional commentary.'] : []),
        localChatInstruction,
        `The article is saved. Show ${run.export_path} as the deliverable in your completion message, with the number of screenshots when known.`,
        'Do not automatically ask whether to publish or start sign-in. If the user explicitly asks to host the saved articles, use supportpages_publish.',
        ...(hosting_invitation
          ? ['If the user then asks to host it, ask whether to sign in or create a free SupportPages.io account and call supportpages_publish. Never start sign-in or upload without that request, and never ask another mandatory question.']
          : ['Do not add a hosting invitation to this completion. If the user asks to host or share it, ask whether to sign in or create a free SupportPages.io account, then use supportpages_publish.']),
        'If the user asks to stop hosting reminders, call supportpages_set_hosting_reminders with enabled=false. Enable them again only when requested.',
        ...(defaultFolder ? ['The output folder is usually ignored by git: suggest copying index.md and its screenshots into the docs.'] : []),
      ] };
  }
  private async delivery(run: Run) {
    if (!run.remote) fail('not_uploaded', 'The run has no uploaded draft.');
    // A replay returns the invitation this draft already got.
    let repository_invitation: RepositoryInvitation | undefined = run.repository_reminder_checked ? run.repository_invitation : undefined;
    let repository_connection;
    if (!run.repository_reminder_checked) {
      try {
        const binding = await this.binding();
        try {
          const fresh = parse(contextSchema, await this.api.request('GET', `/projects/${binding.project_id}/context`, undefined, undefined, 3000), 'invalid_response');
          if (fresh.project.id === binding.project_id) repository_connection = fresh.repository_connection;
        } catch { /* Connection lookup is optional; delivery is already confirmed. */ }
        // Without a known connection state this article is not counted, so a failed
        // lookup never uses up a reminder slot; a later completion checks again.
        if (!repository_connection) throw Error('Repository connection state unknown.');
        // Mark this delivery checked even if the optional global journal fails.
        await this.runs.save({ ...run, repository_reminder_checked: true });
        repository_invitation = await new RepositoryReminders(this.configDir).complete({
          origin: this.api.origin, projectId: binding.project_id, articleId: run.local_article_id,
          connection: run.remote.status === 'draft' ? repository_connection : undefined,
          firstWriterStartedAt: run.first_writer_started_at, readyAt: run.ready_for_review_at,
        });
        if (repository_invitation) await this.runs.save({ ...run, repository_reminder_checked: true, repository_invitation });
      } catch { repository_invitation = undefined; /* Reminders must never turn a saved draft into an upload failure. */ }
    }
    return { status: run.remote.status === 'published' ? 'published' : 'ready_for_review', run_id: run.id,
      slug: run.artifact_dir.split('/').at(-1), article: run.remote, editor_url: run.remote.editor_url,
      repository_connection, ...(repository_invitation ? { repository_invitation, show_to_user: repositoryShowText(repository_invitation) } : {}),
      open_when_ready: Boolean(run.open_when_ready && !run.progress?.open_attempted),
      instructions: [
        ...(repository_invitation ? ['Show show_to_user verbatim as its own paragraph, right after the draft review link. It is part of this result, not optional commentary.'] : []),
        articleChatInstruction,
        'Always show the editor link. Browser-opening failure does not invalidate this saved draft.',
        ...(repository_invitation
          ? ['Never open the repository connection page automatically or ask another mandatory question.']
          : ['Do not add a repository connection invitation to this completion.']),
        'If the user asks to stop repository reminders, call supportpages_set_repository_reminders with enabled=false. Enable them again only when requested.',
        run.open_when_ready && !run.progress?.open_attempted ? 'Opening when ready is enabled for this run: use the host’s browser-opening capability with editor_url. If unavailable, leave the clickable link. Never automate the Publish button.' : 'Do not open a browser unless the user asks.',
        run.remote.status === 'published' ? 'Return the public URL; this article is already published.' : 'Ask once: Would you like me to publish it? Wait for an affirmative response for this draft; otherwise leave it unpublished.',
        'If authorized, call supportpages_publish_article with the returned slug and article.revision. If publishing permission is missing, provide the editor link for browser publication. On revision conflict preserve the browser edits and direct the user to publish there; do not re-upload.' ] };
  }
  private async reportProgressEvent(run: Run, event: string) {
    if (!run.progress?.article) return;
    try {
      await this.api.request('POST', `/projects/${run.project_id}/generation_runs/${run.id}/event`, { event, attempt: run.progress.attempt });
    } catch (error) {
      await this.runs.save({ ...run, progress: { ...run.progress, sync_error: publicError(error).message } });
    }
  }
  async retryArticle(input: { run_id: string; stopped: true }) {
    if (!input.stopped) fail('writer_not_stopped', 'Stop the previous writer before retrying.');
    this.relay.stop();
    return this.lock(async () => {
      let run = await this.runs.read(input.run_id);
      const local = !run.project_id;
      if (local) {
        if (await this.destination() !== 'local') fail('destination_mismatch', 'This article was written for local saving, but the folder now has a help centre. Prepare it again as a new article.');
      } else {
        const binding = await this.binding();
        if (run.project_id !== binding.project_id || run.api_origin !== binding.api_origin) fail('destination_mismatch', 'This article belongs to a different help centre. Switch to that project before resuming it.');
      }
      const context = await this.contextFor(local ? 'local' : 'hosted');
      if (!local) await new ProjectSync(this).guard(run.local_article_id, context);
      if (run.status === 'finalized' || run.remote) fail('invalid_run', 'Retry complete_article for a finished bundle; do not regenerate it.');
      const writerModel = (await executionSettings(this, 'claude')).model;
      const codexWriter = await executionSettings(this, 'codex');
      await this.runs.assertAvailable(run.id);
      if (!run.progress && !local) checkArticleCapacity(context.article_capacity);
      if (run.progress && !run.progress.article) {
        // The server checks capacity only when creating a new preview. Looking up
        // an existing run must still work if its earlier creation filled the plan.
        try { await this.relay.ensureStartedUnlocked(run.id); }
        catch (error) { if (publicError(error).code !== 'run_closed') throw error; }
        run = await this.runs.read(run.id);
      }
      if (run.progress?.article) {
        const next = run.progress.next_attempt ?? randomUUID();
        await this.runs.save({ ...run, progress: { ...run.progress, next_attempt: next } });
        const result = parse(progressResponse, await this.api.request('POST', `/projects/${run.project_id}/generation_runs/${run.id}/event`, { event: 'resume', attempt: run.progress.attempt, next_attempt: next }), 'invalid_response');
        run = { ...run, progress: { attempt: next, sequence: 0, article: result.article, open_attempted: run.progress.open_attempted, browser_opened: run.progress.browser_opened } };
      }
      run = { ...run, status: 'prepared', phase: 'prepared', session_id: this.sessionId, error: undefined, host_task_id: undefined,
        execution_mode: undefined, writer_token: randomUUID(), writer_started_at: undefined, writer_completed_at: undefined };
      await this.runs.save(run);
      await this.ws.writeJson(`${this.stateRoot}/active-run.json`, run);
      const entrypoint = writerEntry(this.ws.root, this.stateRoot, run.id, this.skillsDir, run.writer_token);
      const contextPath = `${this.stateRoot}/runs/${run.id}/context.json`;
      const previousContext = await this.ws.json(contextPath) as Record<string, unknown>;
      const contextFile = await this.ws.writeJson(contextPath, { ...previousContext, ...context,
        project_overview: previousContext.project_overview, analysis_summary: previousContext.analysis_summary, project_name: context.project.name });
      const writerWorkspace = await this.ws.resolve(run.codebase_dir ?? '.');
      const outputPath = await this.ws.resolve(run.artifact_dir);
      const link = articleLink(run);
      this.relay.start(run.id);
      return { run_id: run.id, ...link, prefer_background: run.prefer_background, ...(local ? { local: true, link_instructions: localChatInstruction } : {}),
        task_brief: { name: writerAgentName, claude_model: writerModel, codex_model: codexWriter.model, codex_reasoning_effort: codexWriter.effort,
          prefer_background: run.prefer_background, reporting_instructions: writerReportingInstruction(run.prefer_background === true),
          run_id: run.id, entrypoint, execution: entrypoint.execution, completion: entrypoint.completion, editor_url: link.editor_url, writer_instructions: claudeWriterAgents[writerAgentType].prompt, workspace: writerWorkspace, artifact_dir: run.codebase_dir && run.codebase_dir !== '.' ? outputPath : run.artifact_dir,
          environment: { RTFM_WORKSPACE: writerWorkspace, RTFM_CONTEXT_FILE: contextFile, RTFM_OUTPUT_DIR: outputPath, RTFM_SKILLS_DIR: this.skillsDir, RTFM_MAX_IMAGES: String(writerScreenshotLimit), PATH: path.dirname(process.execPath) + path.delimiter + (process.env.PATH ?? '') },
          instructions: [entrypoint.instruction, entrypoint.execution.instruction, `The application and its .rtfm cache are in ${writerWorkspace}. Use ${outputPath} as OUT for every skill command instead of the default ./output/articles directory.`, `Follow the article instructions returned by the entry check. Resume this article in ${outputPath}; retain valid prose and images, finish missing or failed work, rerun final rendering and fidelity validation. Do not edit app source, upload, publish or call MCP tools.`, entrypoint.completion.instruction] },
        instructions: `${local ? localChatInstruction : link.link_instructions} ${writerLaunchInstruction} ${codexWriterLaunchInstruction} ${backgroundParentInstruction} Launch this recovery task using the host coding agent without worktree isolation, then report started with update_run. On success call complete_article.${local ? ' The article is saved locally when complete; there is no preview link.' : ' Show the same preview link; do not open a second tab.'}` };
    });
  }
  get hosted() { return new HostedOperations(this); }
  async createArticle(input: { title?:string; recommendation_id?:string; description?:string; article_type:z.infer<typeof articleType>; publish?:boolean; request_id?:string; prefer_background?:boolean; open_when_ready?:boolean }) {
    if(input.recommendation_id && input.title || !input.recommendation_id && !input.title)fail('invalid_request','Provide either a title or an accepted recommendation_id.');
    const decision=await resolveAction(this,'create_article');
    if(!decision.allowed) requireExecution(decision,decision.execution);
    if(decision.execution==='local') {
      if(await this.destination()==='none' && !this.api.configured()) await this.saveLocal({version:1,export_dir:'output/articles'});
      if(!input.title || input.recommendation_id)fail('invalid_request','Local creation requires an article title.');
      const prepared=await this.prepare({...input,title:input.title});
      return {...prepared,publication_requested:input.publish===true};
    }
    return this.hosted.submit('create_article',input.recommendation_id ? {recommendation_id:input.recommendation_id,publish:input.publish??false} : {title:input.title,description:input.description,article_type:input.article_type ?? 'how-to',publish:input.publish??false},{...input,decision});
  }
  async editArticle(input: { article_id:string; expected_revision:string; instructions:string; request_id?:string; prefer_background?:boolean; open_when_ready?:boolean }) {
    const decision=await resolveAction(this,'edit_article',input.article_id);
    if(!decision.allowed) requireExecution(decision,decision.execution);
    if(decision.execution==='local') {
      const article=await this.getArticle(input.article_id);
      if(article.revision!==input.expected_revision)fail('revision_conflict','Read the current article before editing.');
      return {status:'local_edit_required',execution:'local',article,editing_instructions:input.instructions,
        next_tool:'supportpages_update_article',expected_revision:input.expected_revision,
        instructions:'Apply the requested edit locally to the returned content. Preserve unchanged text, image references and content format, then call update_article with this article_id and expected_revision. Do not create another article. A failed save or conflict leaves the existing article unchanged.'};
    }
    return this.hosted.submit('edit_article',{article_id:input.article_id,expected_revision:input.expected_revision,instructions:input.instructions},{...input,decision});
  }
  async createWalkthrough(input:{article_id?:string;expected_revision?:string;request_id?:string;prefer_background?:boolean;open_when_ready?:boolean}) {
    const decision=await resolveAction(this,'create_video_walkthrough',input.article_id);
    if(!decision.allowed)return {status:'action_required',...decision};
    if(!input.article_id)return {status:'article_required',instructions:'Choose a completed article using list_articles, then request its walkthrough with article_id.'};
    const article=await this.getArticle(input.article_id);
    return this.hosted.submit('create_video_walkthrough',{article_id:input.article_id,expected_revision:input.expected_revision??article.revision},{...input,decision});
  }
  async listSuggestions(kind:'sections'|'recommendations',afterId?:string) {
    requireExecution(await resolveAction(this,'read_articles'),'remote');
    if(afterId)parse(remoteId,afterId);
    const binding=await this.binding();
    const item=kind==='sections'?sectionSuggestion:articleSuggestion;
    return parse(z.object({kind:z.literal(kind),items:z.array(item),next_cursor:remoteId.nullable()}),await this.api.request('GET',`/projects/${binding.project_id}/writer/${kind}${afterId?`?after_id=${afterId}`:''}`),'invalid_response');
  }
  async reviewSuggestion(kind:'sections'|'recommendations',id:string,decision:'accept'|'reject') {
    parse(remoteId,id);
    requireExecution(await resolveAction(this,kind==='sections'?'review_sections':'review_recommendations'),'remote');
    const binding=await this.binding();
    const raw=await this.api.request('PATCH',`/projects/${binding.project_id}/writer/${kind}/${id}`,{decision});
    const item=kind==='sections'?parse(sectionSuggestion,raw,'invalid_response'):parse(articleSuggestion,raw,'invalid_response');
    if(item.id!==id)fail('invalid_response','The server returned another suggestion.');
    return item;
  }
  async listArticles(afterId?: string, source: 'auto' | 'local' | 'hosted' = 'auto') {
    if (source === 'local' && afterId) fail('invalid_request', 'Local article listings do not use a hosted cursor.');
    if (source === 'local' || source === 'auto' && !afterId && (!this.api.configured() || await this.destination() === 'local')) return localArticleInventory(this);
    const decision = await resolveAction(this, 'read_articles');
    if (source === 'auto' && !afterId && decision.next_step?.code === 'authentication_required') return localArticleInventory(this);
    requireExecution(decision, 'remote');
    if (afterId) parse(remoteId, afterId);
    const binding = await this.binding();
    return parse(z.object({ articles: z.array(remoteArticleSchema.passthrough()), next_cursor: remoteId.nullable() }), await this.api.request('GET', `/projects/${binding.project_id}/articles${afterId ? `?after_id=${afterId}` : ''}`), 'invalid_response');
  }
  async mutateArticle(action: 'update_article' | 'publish_article' | 'unpublish_article' | 'delete_article', input: { article_id: string; expected_revision: string; structured_content?: unknown; body?: string; title?: string }) {
    parse(remoteId, input.article_id);
    if (!/^[a-f0-9]{64}$/.test(input.expected_revision)) fail('invalid_revision', 'Use the revision returned by get_article.');
    requireExecution(await resolveAction(this, action, input.article_id), 'remote');
    const binding = await this.binding();
    const route = `/projects/${binding.project_id}/articles/${input.article_id}`;
    const method = action === 'update_article' ? 'PATCH' : action === 'delete_article' ? 'DELETE' : 'POST';
    const suffix = action === 'publish_article' ? '/publish' : action === 'unpublish_article' ? '/unpublish' : '';
    const { article_id, ...body } = input;
    const response = await this.api.request(method, route + suffix, body);
    const result = action === 'delete_article'
      ? parse(z.object({ id: remoteId, deleted_at: z.iso.datetime() }), response, 'invalid_response')
      : parse(remoteArticleSchema.passthrough(), response, 'invalid_response');
    if (result.id !== article_id) fail('invalid_response', 'The server returned a different article.');
    return result;
  }
  async getArticle(articleId: string) {
    parse(remoteId, articleId);
    const binding = await this.binding();
    const result = parse(remoteArticleSchema.passthrough(), await this.api.request('GET', `/projects/${binding.project_id}/articles/${articleId}`), 'invalid_response');
    if (result.id !== articleId) fail('invalid_response', 'The server returned a different article.');
    return result;
  }
  async publish(slug: string, expectedRevision: string) {
    return this.lock(async () => {
      const binding = await this.binding();
      const stateFile = `${this.stateRoot}/articles/${slug}.json`;
      const state = parse(localSchema, await this.ws.json(stateFile));
      if (!state.remote) fail('not_uploaded', 'Upload this article as a draft before publishing.');
      if (state.uploaded_bundle_hash !== state.bundle_hash) fail('not_uploaded', 'Upload the newly finalized bundle before publishing it.');
      if (state.remote.revision !== expectedRevision) fail('revision_conflict', 'The requested revision differs from the last uploaded revision.');
      // A newer local bundle must be uploaded before publishing it.
      await verifyBundle(this.ws, state.bundle_dir);
      const result = parse(remoteArticleSchema, await this.api.request('POST', `/projects/${binding.project_id}/articles/${state.remote.id}/publish`, { expected_revision: expectedRevision, bundle_hash: state.bundle_hash }), 'invalid_response');
      await this.ws.writeJson(stateFile, { ...state, remote: result });
      const { manifest } = await verifyBundle(this.ws, state.bundle_dir);
      if (await this.ws.exists(`${this.stateRoot}/runs/${manifest.run_id}/run.json`)) {
        const run = await this.runs.read(manifest.run_id);
        await this.runs.save({ ...run, remote: result, phase: 'published' });
      }
      return result;
    });
  }
}

const sectionSuggestion=z.object({id:remoteId,name:z.string(),slug:z.string(),description:z.string().nullable(),justification:z.string().nullable(),status:z.enum(['pending','accepted','rejected']),visible:z.boolean()});
const articleSuggestion=z.object({id:remoteId,section_id:remoteId.nullable(),title:z.string(),description:z.string().nullable(),justification:z.string().nullable(),article_type:articleType,status:z.enum(['pending','accepted','rejected','generated']),article_id:remoteId.nullable()});
