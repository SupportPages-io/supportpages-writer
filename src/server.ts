import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Session } from './session.js';
import type { Bridge } from './bridge.js';
import { articleType, idSchema, remoteId } from './schema.js';
import { fail, publicError } from './errors.js';
import { articleLinkContent, showArticleLinkInstruction } from './article-link.js';
import { writerLaunchInstruction, codexWriterLaunchInstruction, backgroundParentInstruction } from './writer-agent.js';
import { runUpdateAcknowledgement, runUpdateText } from './run-update.js';
import { resolveAction, writerAction } from './actions.js';
import { repositoryAction } from './repository-actions.js';
import { Walkthroughs } from './walkthroughs.js';
import { activeTelemetry, reportError } from './telemetry.js';
/** Shared errors and decisions name terminal commands because the CLI shows
 * them too. A coding agent recovers through these tools instead: it never sends
 * the user to a terminal, and it asks before signing anyone in. */
const signInGuidance = 'Ask whether the user wants to sign in or create a free SupportPages.io account to host articles there. If they do, call supportpages_init with host_local=true (signup=true for a new account): it opens browser approval, then offers the help centre choice; call it again with the chosen project_id to link this folder. Retry this request afterwards. Never direct the user to a terminal command.';
const mcpRecovery: Record<string, { next_tool: string; message: string }> = {
  authentication_required: { next_tool: 'supportpages_init', message: `This device is not signed in to SupportPages.io. ${signInGuidance}` },
  missing_credentials: { next_tool: 'supportpages_init', message: `This device is not signed in to SupportPages.io. ${signInGuidance}` },
  invalid_credentials_file: { next_tool: 'supportpages_init', message: `The saved device sign-in cannot be read. ${signInGuidance}` },
  invalid_credentials: { next_tool: 'supportpages_init', message: 'The device sign-in has expired or was revoked. Ask before signing in again with supportpages_init, then retry this request. Never direct the user to a terminal command.' },
  local_workspace: { next_tool: 'supportpages_init', message: 'This folder saves articles locally and has no help centre. Ask whether the user wants to sign in or create a free SupportPages.io account. If they do, call supportpages_init with host_local=true (signup=true for a new account): it opens browser approval, offers the help centre choice and links this folder once called again with the chosen project_id; saved files stay in place. Use supportpages_publish instead when the saved articles should be uploaded as well. Never direct the user to a terminal command.' },
  local_required: { next_tool: 'supportpages_init', message: 'This folder is no longer set up to save articles locally. Call supportpages_init to set it up again, then retry.' },
  setup_required: { next_tool: 'supportpages_init', message: 'This folder is not set up yet, and setting it up needs no account. It can save articles in the project as Markdown and screenshots with no sign-in, or publish them to a SupportPages.io help centre for a public URL, editor review and AI answers. Ask which the user wants, then call supportpages_init (signup=true only when they chose to create a new account) and retry. Never present hosting as required, and never direct the user to a terminal command.' },
  project_required: { next_tool: 'supportpages_init', message: 'Signed in, but this folder is not linked to a help centre. Ask which help centre to use (supportpages_list_projects), or create one with supportpages_create_project, then call supportpages_init with that project_id and retry.' },
  permission_required: { next_tool: 'supportpages_request_permissions', message: 'This action needs device permissions the user has not approved yet. Call supportpages_request_permissions with the missing scopes, wait for browser consent, then retry. Never direct the user to a terminal command.' },
};
function forAgent<T>(value: T): T {
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const rewrite = (item: Record<string, unknown>) => {
    const recovery = typeof item.code === 'string' ? mcpRecovery[item.code] : undefined;
    if (!recovery || typeof item.message !== 'string') return item;
    const scopes = Array.isArray(item.missing_scopes) && item.missing_scopes.length ? ` Missing scopes: ${item.missing_scopes.join(', ')}.` : '';
    return { ...item, message: recovery.message + scopes, next_tool: recovery.next_tool };
  };
  const decision = (item: unknown) => item && typeof item === 'object' && (item as Record<string, unknown>).next_step && typeof (item as Record<string, unknown>).next_step === 'object'
    ? { ...item as Record<string, unknown>, next_step: rewrite((item as Record<string, unknown>).next_step as Record<string, unknown>) } : item;
  let result: Record<string, unknown> = decision(record) as Record<string, unknown>;
  if (result.writer_action) result = { ...result, writer_action: decision(result.writer_action) };
  if (result.error && typeof result.error === 'object') {
    const error = rewrite(result.error as Record<string, unknown>);
    const details = error.details && typeof error.details === 'object' ? error.details as Record<string, unknown> : undefined;
    result = { ...result, error: details?.writer_action ? { ...error, details: { ...details, writer_action: decision(details.writer_action) } } : error };
  }
  return result as T;
}
function packageVersion() {
  try { return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version as string; } catch { return '0.0.0'; }
}
export function createServer(source: Bridge | Session) {
  const server = new McpServer({ name: 'supportpages', version: packageVersion() }, { instructions:
    'For article inventory questions such as what support articles do we have, call supportpages_list_articles first, without status or init. It reads local files when signed out or in local mode; report those results without requesting login. Use source=hosted only when the user explicitly requests the hosted inventory. Do not infer local inventory from git status. ' +
    'Every account step happens through these tools with the user’s browser consent: never direct the user to run a supportpages terminal command. When a tool reports authentication_required, or the user asks for anything hosted while signed out, first ask whether they want to sign in or create a free SupportPages.io account; then call supportpages_init (host_local=true from a folder that saves articles locally, signup=true for a new account) and again with the chosen project_id, or supportpages_publish when saved local articles should be uploaded too. For requested hosted generation or analysis, follow the returned setup step in order: browser sign-in/account creation, help-centre selection, device permissions, then browser repository connection. The action tools open required setup pages; show the returned URL only if browser_opened is false. Continue with supportpages_setup_hosted and its next_arguments after each step, then retry resume_tool with resume_arguments. Never substitute the app homepage or skip sign-in to invite repository connection. User browser consent remains required. ' +
    'For questions about existing hosted videos or video walkthroughs, call supportpages_list_walkthroughs, then supportpages_get_walkthrough for details. Article lists and local files are not the hosted video inventory. If the tools report server_update_required, explain that the hosted API needs deployment and stop this read request; do not substitute a filesystem search or infer that there are no videos. ' + showArticleLinkInstruction + ' ' + writerLaunchInstruction + ' ' + codexWriterLaunchInstruction + ' ' + backgroundParentInstruction + ' For article creation requests, check supportpages_status and finish supportpages_init when needed, preserving the original request. Always call supportpages_create_article to choose the permitted execution location before writing any article content or images, even if a generation skill was selected directly or is cached in this session. A hosted operation runs entirely in SupportPages: show the returned review link, which fills in as the article is written, then finish the turn. Do not poll it with supportpages_get_operation — use that only when the user asks how a run is going, or to recover after a client restart — and never launch a local writer. A local result uses the prepared task described below. Generation skills are private writer implementation files, not the main-agent entry point. Hand the prepared task brief to the writer, which must pass its entrypoint check first. It checks account-wide hosting capacity first. If preparation returns plan_limit, do not launch a writer: show the usage, upgrade link and manage-articles link, then wait for the user to free capacity or upgrade before retrying preparation. Prepare the article without preference overrides unless the user explicitly requests a different behavior; saved personal preferences apply. Preparation creates the preview when supported. Show its editor_url before launching any writer. Preparation does not start writing: follow the returned prefer_background setting to launch the task_brief in the foreground or using the current coding client background facility, then report started with supportpages_update_run. Use the existing directory in task_brief.workspace without worktree isolation or a new checkout. If background execution is unavailable or requires a worktree, explain and use foreground for the same prepared run. After update_run, show its preview link again, including when it came from an earlier run. If a tool reports an error, show any editor_url in error.details alongside the error and recovery instructions. The writer entrypoint records actual startup locally and activates the prepared relay even if the host misses update_run. Host updates still record execution mode and task identity. The relay uploads live previews and opens the browser once when readable text arrives if enabled. Do not open it a second time. For retry requests call retry_article after stopping the old writer. The writer only generates and validates local artifacts; the main agent handles MCP calls after the host completion notification. On success call supportpages_complete_article automatically, show its draft editor link, open it only if the returned open_when_ready is true, and ask whether the user wants this draft published. If completion reports upload_failed, generation is finished but delivery to the editor is unconfirmed: show the specific cause, editor link and next action, do not call update_run with failed, and do not infer that no remote draft exists. No answer means leave a draft. Never publish without an affirmative response for that draft, automate browser publication, or overwrite browser edits after a revision conflict. Stop host tasks before releasing runs. Do not claim progress is live after a client restart. Do not launch a separate agent CLI or ask for model/API credentials. If status or init reports local, this folder has no help centre: articles are saved as Markdown and screenshots, and the saved markdown path returned by complete_article is the deliverable. Show that path instead of an editor link and never ask whether to publish automatically. Only when the user explicitly asks to host or publish saved local articles, call supportpages_publish and follow its sign-in, help-centre and article-selection steps. Otherwise do not start browser sign-in or upload. A completion may return show_to_user: show that text verbatim as its own paragraph, after the saved path or draft review link, and nothing more; when absent, add no hosting or repository copy. If the user asks to stop hosting reminders, call supportpages_set_hosting_reminders with enabled=false. When a result includes telemetry_notice, show it once, verbatim. If the user asks to stop or allow anonymous usage reporting, call supportpages_set_telemetry.' });
  activeTelemetry()?.setClient(() => server.server.getClientVersion()?.name);
  const atWorkspace = async (workspace?: string, resumeCompletion = true) => 'bridge' in source ? source.bridge(await source.workspace(workspace), { resumeCompletion }) : source;
  const bridge = new Proxy({} as Bridge, { get: (_target, key) => async (...args: unknown[]) => {
    const resolved = 'bridge' in source ? await source.bridge() : source;
    return (resolved[key as keyof Bridge] as Function).apply(resolved, args);
  } });
  if ('bridge' in source) source.roots = async () => {
    if (!server.server.getClientCapabilities()?.roots) return undefined;
    const { roots } = await server.server.listRoots();
    return roots.filter(root => root.uri.startsWith('file:')).map(root => fileURLToPath(root.uri));
  };
  if ('bridge' in source) {
    source.approval = async request => {
      if (!server.server.getClientCapabilities()?.elicitation?.url) return 'unsupported';
      const result = await server.server.elicitInput({ mode: 'url', url: request.url,
        elicitationId: request.id,
        message: `Sign in to SupportPages.io from this device. Compare code ${request.code} in your browser and approve sign-in. Allowing publishing is optional.` }, { timeout: 30_000 });
      return result.action;
    };
    source.approvalCompleted = id => server.server.createElicitationCompletionNotifier(id)();
    source.askForm = async (message, requestedSchema) => {
      if (!server.server.getClientCapabilities()?.elicitation?.form) return undefined;
      const result = await server.server.elicitInput({ mode: 'form', message, requestedSchema }, { timeout: 300_000 });
      return { action: result.action, content: result.content as Record<string, unknown> | undefined };
    };
  }
  // Hosted requests the device cannot serve without an account: the client's
  // own dialog asks first, and a linked folder retries the request in place.
  const accountOffered = new Set(['list_articles', 'list_walkthroughs', 'get_walkthrough', 'get_article', 'update_article', 'publish_article', 'unpublish_article', 'delete_article', 'edit_article',
    'list_sections', 'list_recommendations', 'review_sections', 'review_recommendations', 'get_operation', 'retry_operation', 'sync', 'list_projects', 'upload_draft']);
  const accountCodes = new Set(['authentication_required', 'missing_credentials', 'local_workspace']);
  server.server.onclose = () => source.close();
  const tool = <T extends z.ZodRawShape>(name: string, description: string, schema: T, handler: (args: z.infer<z.ZodObject<T>>) => Promise<unknown>, readOnly = false, remote = false, options: { destructiveHint?: boolean; successText?: (result: unknown) => string } = {}) => {
    const { successText, ...annotations } = options;
    server.registerTool(`supportpages_${name}`, {
      description, inputSchema: z.object(schema as z.ZodRawShape),
      outputSchema: z.object({ result: z.unknown().optional(), error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }).optional() }),
      annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly && remote, openWorldHint: remote, ...annotations },
    }, async args => {
      const attempt = async (offer: boolean): Promise<any> => { try {
        const result = forAgent(await handler(z.object(schema).parse(args)));
        const data = { result };
        return { content: [{ type: 'text' as const, text: successText ? successText(result) : JSON.stringify(data) }, ...articleLinkContent(result)], structuredContent: data };
      } catch (error) {
        reportError(error, name);
        const safe = publicError(error);
        const input = args as Record<string, unknown>;
        if (offer && 'offerAccount' in source && accountOffered.has(name) && accountCodes.has(safe.code)) {
          const outcome = await source.offerAccount(await source.workspace(typeof input.workspace === 'string' ? input.workspace : undefined), { need: 'This request needs your SupportPages.io help centre.' });
          if (outcome.status === 'linked') return attempt(false);
          if (outcome.status !== 'unavailable') {
            const message = outcome.status === 'declined'
              ? `${outcome.asked ? 'The user chose not to sign in.' : 'The user chose not to sign in earlier in this session.'} Continue without the hosted help centre and do not ask again unless they raise it.`
              : outcome.status === 'authentication_required' ? `The user chose to sign in and the approval page ${outcome.browser_opened ? 'was opened in their browser: tell them to approve it there and show the comparison code, not the link' : 'could not be opened automatically: say so, show browser_url for them to open, and show the comparison code'}. It was not approved within the wait, so call supportpages_status to check and retry this request once signed in.`
              : 'Sign-in finished but no help centre was chosen. Ask which help centre to use, then call supportpages_init with host_local=true and that project_id, and retry this request.';
            const data = { error: { code: safe.code, message, details: { ...(safe.details && typeof safe.details === 'object' ? safe.details as Record<string, unknown> : {}), account_offer: outcome } } };
            return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(data) }], structuredContent: data };
          }
        }
        const data = forAgent({ error: safe });
        const details = data.error.details && typeof data.error.details === 'object' ? data.error.details as Record<string, unknown> : {};
        if (input.run_id || input.title || input.artifact_dir || details.run_id) {
          try {
            const selected = await atWorkspace(typeof input.workspace === 'string' ? input.workspace : undefined);
            const link = await selected.articleErrorContext({ ...input, run_id: input.run_id ?? details.run_id });
            if (link) data.error.details = { ...link, ...details };
          } catch { /* Preserve the original error when its local journal cannot be read. */ }
        }
        return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(data) }, ...articleLinkContent(data.error)], structuredContent: data };
      } };
      return attempt(true);
    });
  };
  tool('init', 'Sign this device in to SupportPages.io if needed and link the current workspace to a help centre. A folder set up to save articles locally returns local without any sign-in unless host_local=true, which means the user explicitly asked to sign in or use a help centre from it. Without a device sign-in it opens browser approval when supported, otherwise returns an approval link: show the link and comparison code to the user; sign-in completes privately in the background (check supportpages_status). Once signed in, a workspace with no linked help centre returns project_required with the account’s help centres: ask the user which one to use, then call this tool again with that project_id, or call supportpages_create_project first. Never accept a token in chat or approve for the user.', { workspace: z.string().optional().describe('Select an absolute client workspace root only when discovery is ambiguous.'), project_id: remoteId.optional().describe('Help centre to link this workspace to when it is not linked yet.'), signup: z.boolean().optional().describe('True when the user chose to create a free SupportPages.io account: browser approval starts on registration instead of sign-in.'), host_local: z.boolean().optional().describe('True when the user explicitly asked to sign in or use a help centre from a folder that saves articles locally. Sign-in proceeds and, once a project_id is chosen, the link makes the folder hosted while its saved files stay in place.') }, async a => {
    const result = await ('init' in source ? source.init(a) : source.context());
    const status = result && typeof result === 'object' ? (result as { status?: unknown }).status : undefined;
    const notice = status === 'local' || status === 'ready' ? await activeTelemetry()?.notice() : undefined;
    return notice ? { ...result as object, telemetry_notice: notice } : result;
  }, false, true);
  const dir = z.string().min(1).max(500).describe('Workspace-relative article output directory.');
  tool('publish', 'Host saved local articles on a SupportPages.io help centre. Use only when the user asks to host or publish saved local articles, after asking whether they want to sign in or create a free account. Signs in through browser approval if needed, links a chosen help centre, and uploads selected articles as drafts. With no slugs, returns the available articles for selection; pass their slugs to upload. Follow authentication_required or project_required responses and call again after approval or selection. This changes the folder to hosted generation and preserves local files. It does not make articles publicly visible; publish_article is the separate public publication action. Never use automatically after local generation.', {
    workspace: z.string().optional(), project_id: remoteId.optional().describe('The help centre the user selected; cannot replace an existing destination.'),
    slugs: z.array(idSchema).max(1000).optional().describe('Saved article slugs selected by the user. Omit to list choices; an empty array uploads nothing.'),
    signup: z.boolean().optional().describe('True when the user chose to create a free SupportPages.io account rather than sign in.'),
  }, async a => {
    if ('bridge' in source) return source.publish(a);
    if (a.project_id) await source.bind(a.project_id, { requireIdle: true });
    return source.uploadLocalArticles(a.slugs);
  }, false, true, { destructiveHint: false });
  tool('status', 'Check article progress and draft links, the signed-in account, browser approval progress and access to the linked help centre. Does not start authentication, open a browser, change bindings or expose credentials. Uses a read-only API check when configured.',
    { workspace: z.string().optional().describe('Select a client workspace root when discovery is ambiguous.'), run_id: z.uuid().optional().describe('Inspect a particular article run; otherwise shows the active or most recent run.') },
    a => 'init' in source ? source.status(a) : source.status(a.run_id), true, true);
  tool('doctor', 'Check configuration and local generation prerequisites without exposing credentials.', {}, () => bridge.doctor(), true);
  tool('get_capabilities', 'Check whether an action can run and return its execution location or next setup step. No job or browser consent is started.', {
    workspace: z.string().optional(), action: writerAction, article_id: remoteId.optional(),
  }, async a => resolveAction(await atWorkspace(a.workspace, false), a.action, a.article_id), true, true);
  tool('request_permissions', 'Request explicit browser consent for missing Writer permissions. Preserve the original action and retry it after consent. Never approve the browser form for the user.', {
    workspace: z.string().optional(), action: writerAction, article_id: remoteId.optional(), scopes: z.array(z.enum(['publish', 'manage', 'generate'])).min(1).max(3),
  }, async a => {
    if ('requestPermissions' in source) return source.requestPermissions(a);
    throw new Error('Permission consent requires a managed device session.');
  }, false, true);
  for(const action of ['find_article_gaps','suggest_sections','recommend_articles'] as const) {
    tool(action, 'Run hosted documentation analysis and return a durable operation. Suggestions remain pending for review. Never analyse locally, accept suggestions automatically or generate articles implicitly.', {
      workspace:z.string().optional(),request_id:z.uuid().optional().describe('Use a new UUID for a new intentional request, and reuse it for recovery. Omitted reuses the saved identical request.'),prefer_background:z.boolean().optional(),open_when_ready:z.boolean().optional(),
    },async a=>{
      const selected=await atWorkspace(a.workspace,false);
      const decision=await resolveAction(selected,action);
      if(!decision.allowed)return 'setupHosted' in source
        ? { ...await source.setupHosted({ workspace: a.workspace, action, resume_arguments: a }), resume_tool: `supportpages_${action}`, resume_arguments: a }
        : {status:'action_required',...decision};
      return selected.hosted.submit(action,{}, {...a,decision});
    },false,true);
  }
  for(const kind of ['sections','recommendations'] as const) {
    tool(`list_${kind}`, 'List persisted suggestions with IDs and review state. Use after_id to read the next page.', {workspace:z.string().optional(),after_id:remoteId.optional()},async a=>(await atWorkspace(a.workspace,false)).listSuggestions(kind,a.after_id),true,true);
    tool(`review_${kind}`, 'Accept or reject one selected suggestion. Acceptance never advances onboarding or starts generation. Generate an accepted article recommendation explicitly with create_article and recommendation_id.', {workspace:z.string().optional(),id:remoteId,decision:z.enum(['accept','reject'])},async a=>(await atWorkspace(a.workspace,false)).reviewSuggestion(kind,a.id,a.decision),false,true);
  }
  tool('create_video_walkthrough', 'Create a hosted video walkthrough for a completed eligible article. Uses project voice/settings and returns a durable operation. Review/playback is private until the user explicitly shares it in SupportPages; never publish, share or record locally.', {
    workspace:z.string().optional(),article_id:remoteId.optional(),expected_revision:z.string().regex(/^[a-f0-9]{64}$/).optional(),request_id:z.uuid().optional().describe('Use a new UUID for a new intentional request, and reuse it for recovery. Omitted reuses the saved identical request.'),prefer_background:z.boolean().optional(),open_when_ready:z.boolean().optional(),
  },async a=>{
    const selected = await atWorkspace(a.workspace, false);
    const response = await selected.createWalkthrough(a);
    if (response.status === 'action_required' && 'setupHosted' in source) return { ...await source.setupHosted({ workspace: a.workspace, action: 'create_video_walkthrough', article_id: a.article_id, resume_arguments: a }), resume_tool: 'supportpages_create_video_walkthrough', resume_arguments: a };
    return response;
  },false,true);
  const setupAction = z.enum(['find_article_gaps', 'suggest_sections', 'recommend_articles', 'create_video_walkthrough']);
  const setupInput = { workspace: z.string().optional(), project_id: remoteId.optional(), article_id: remoteId.optional(),
    signup: z.boolean().optional().describe('True when the user chose to create a free SupportPages.io account rather than sign in.'),
    resume_arguments: z.object({ article_id: remoteId.optional(), expected_revision: z.string().regex(/^[a-f0-9]{64}$/).optional(), request_id: z.uuid().optional(), prefer_background: z.boolean().optional(), open_when_ready: z.boolean().optional() }).optional() };
  const setupDescription = 'Sign in or create an account and connect a repository for the original requested hosted action. Opens browser sign-in first, asks which help centre to use, requests missing device consent, then opens that project repository connection or repair page. After the user completes a step, call again with next_arguments (and the selected project_id when asked). Returns resume_tool and resume_arguments when ready. Never approves consent, chooses a repository, uploads local articles or starts generation.';
  tool('setup_hosted', setupDescription, { ...setupInput, action: setupAction }, async a => {
    if ('setupHosted' in source) return source.setupHosted(a);
    fail('managed_session_required', 'Browser setup requires the managed SupportPages MCP session.');
  }, false, true, { destructiveHint: false });
  tool('connect_repository', 'Compatibility alias for supportpages_setup_hosted. ' + setupDescription, {
    ...setupInput, action: setupAction.optional(), feature: z.enum(['article_gaps', 'video_walkthrough']).default('article_gaps'),
  }, async a => 'setupHosted' in source
    ? source.setupHosted({ ...a, action: a.action ?? (a.feature === 'video_walkthrough' ? 'create_video_walkthrough' : 'find_article_gaps') })
    : repositoryAction(await atWorkspace(a.workspace, false), 'connect_repository', a.feature), false, true, { destructiveHint: false });
  tool('set_repository_reminders', 'Enable or disable optional repository connection reminders when the user asks. Applies to the bound help centre across local checkouts on this device, for this API origin. Disabling lasts until explicitly enabled again; it does not affect article generation or publication.', {
    workspace: z.string().optional(), enabled: z.boolean()
  }, async a => (await atWorkspace(a.workspace)).repositoryReminders(a.enabled));
  tool('set_hosting_reminders', 'Enable or disable the optional hosting reminders shown after an article is saved locally, when the user asks. Needs no account or help centre: the preference covers every local folder on this device for this API origin. Disabling lasts until explicitly enabled again; it does not affect article generation or hosting.', {
    workspace: z.string().optional(), enabled: z.boolean()
  }, async a => (await atWorkspace(a.workspace, false)).hostingReminders(a.enabled));
  tool('set_telemetry', 'Turn the Writer’s anonymous usage counts and crash reports on or off for this device when the user asks. Needs no account. Returns what is sent and the current state; environment variables such as SUPPORTPAGES_TELEMETRY=0 or DO_NOT_TRACK=1 still win.', {
    enabled: z.boolean(),
  }, async a => {
    const telemetry = activeTelemetry();
    if (!telemetry) fail('invalid_configuration', 'Telemetry settings are not available in this session.');
    return telemetry.setEnabled(a.enabled);
  });
  tool('list_projects', 'List accessible SupportPages.io help centres.', {}, () => bridge.listProjects(), true, true);
  tool('create_project', 'Create a SupportPages.io project for local generation; no repository connection is needed.', { name: z.string().trim().min(1).max(100), subdomain: z.string().regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/).min(3).max(63) }, a => bridge.createProject(a.name, a.subdomain), false, true);
  tool('bind_workspace', 'Bind this configured local workspace to a remote project. Refuses to silently change an existing destination.', { project_id: remoteId }, a => bridge.bind(a.project_id), false, true);
  tool('get_context', 'Fetch writing guidance, sections, article inventory and current account-wide article hosting capacity with billing and management links. A local folder returns its writing guidance with no sections, inventory or capacity.', {}, async () => bridge.contextFor(await bridge.destination()), true, true);
  tool('get_local_plan', 'Read validated local project detection context. Sections, recommendations and PR analysis require a repository connection in the web app. This compatibility tool does not expose a local plan. Run supportpages analyse in the project terminal if analysis is required.', {}, () => bridge.localPlan(), true);
  tool('create_article', 'Create one illustrated article using the permitted execution location. Hosted projects run in SupportPages with configured repositories/models; never launch a local writer for a hosted operation. Local responses return the existing prepared writer task. Defaults to draft even if project auto-publish is enabled. Set publish only for an explicit user publication request. Reuse request_id when recovering a lost response.', {
    workspace:z.string().optional(),title:z.string().trim().min(1).max(500).optional(),recommendation_id:remoteId.optional(),description:z.string().max(20_000).optional(),article_type:articleType.default('how-to'),
    publish:z.boolean().default(false),request_id:z.uuid().optional().describe('Use a new UUID for a new intentional request, and reuse it for recovery. Omitted reuses the saved identical request.'),prefer_background:z.boolean().optional(),open_when_ready:z.boolean().optional(),
  },async a=>(await atWorkspace(a.workspace,false)).createArticle(a),false,true);
  tool('edit_article', 'Edit an existing article according to instructions. Read it first and supply its current revision. Repository-connected edits run in SupportPages: send instructions, never write the replacement locally. Account-only drafts return local editing guidance. Successful published edits become live immediately; failures preserve the existing article and images.', {
    workspace:z.string().optional(),article_id:remoteId,expected_revision:z.string().regex(/^[a-f0-9]{64}$/),instructions:z.string().trim().min(1).max(20_000),request_id:z.uuid().optional().describe('Use a new UUID for a new intentional request, and reuse it for recovery. Omitted reuses the saved identical request.'),prefer_background:z.boolean().optional(),open_when_ready:z.boolean().optional(),
  },async a=>(await atWorkspace(a.workspace,false)).editArticle(a),false,true);
  tool('get_operation', 'Check a hosted operation once, when the user asks how it is going or after a client restart; it never resubmits work. Do not call it on a loop while an operation runs: the review link shows progress as it is written. After a restart use the saved operation_id, or omit it to recover the most recent request, including a lost submission response. Polling is bounded to 20 seconds.', {
    workspace:z.string().optional(),operation_id:remoteId.optional(),wait_ms:z.number().int().min(0).max(20_000).default(0),
  },async a=>await (await atWorkspace(a.workspace,false)).hosted.get(a.operation_id,a.wait_ms) ?? {status:'no_operation'},true,true);
  tool('retry_operation', 'Explicitly retry a failed hosted operation after fixing its reported prerequisite. Reuses the operation and target; rechecks permissions. Pass the current attempt from get_operation. Revision conflicts require a new request with a freshly read revision; retry cannot overwrite an old snapshot.', {
    workspace:z.string().optional(),operation_id:remoteId,expected_attempt:z.number().int().positive(),
  },async a=>(await atWorkspace(a.workspace,false)).hosted.retry(a.operation_id,a.expected_attempt),false,true);
  tool('prepare_article', 'Check account-wide article hosting capacity before preparing a writing task and self-contained task brief. Call this before writing content or rendering images. In a local folder there is no capacity check or preview: the response says where the article will be saved. On plan_limit, show usage, upgrade and article-management links and stop; no writer should launch. This creates a preview when supported and returns its editor_url. Show that link immediately before launching the writer. This does not execute generation. Follow the returned personal preference for background or foreground execution; report started after launch and complete automatically after success.', {
    workspace: z.string().optional(), title: z.string().trim().min(1).max(120), description: z.string().max(2000).optional(), article_type: articleType.default('how-to'), section_id: remoteId.optional(),
    allow_duplicate: z.boolean().optional().describe('Only true when the user explicitly wants a separate article despite an existing article with the same title.'),
    prefer_background: z.boolean().optional().describe('Override the saved personal preference only when explicitly requested.'), open_when_ready: z.boolean().optional().describe('Override the saved personal preference only when explicitly requested. Opening does not publish.')
  }, async a => (await atWorkspace(a.workspace)).prepare(a), false, true);
  tool('update_run', 'Report actual host task start, failure, interruption or cancellation. Returns a compact acknowledgement and editor link; use supportpages_status for full run details when needed. Always show the returned editor_url, including after failure or interruption. Cannot mark content delivered or published. Stop the writer before reporting a terminal event.', {
    workspace: z.string().optional(), run_id: z.uuid(), event: z.enum(['started', 'failed', 'interrupted', 'cancelled']),
    execution_mode: z.enum(['foreground', 'background']).optional(), host_task_id: z.string().min(1).max(200).optional(), stopped: z.boolean().optional()
  }, async a => runUpdateAcknowledgement(await (await atWorkspace(a.workspace)).updateRun(a), a.event), false, false, { successText: runUpdateText });
  tool('retry_article', 'Resume the same partial article after stopping the previous writer. Run the returned recovery task, report started, and complete after validation. Always show its returned editor_url before retrying, even if the link was already shown or the operation fails. Never retry a draft the user kept for editing.', { workspace: z.string().optional(), run_id: z.uuid(), stopped: z.literal(true) }, async a => (await atWorkspace(a.workspace)).retryArticle(a), false, true);
  tool('complete_article', 'After successful host writing and validation, finalize and upload this run as a draft. In a local folder it saves the article as Markdown with its screenshots and returns the saved path instead of an editor link. Safe to retry after an upload failure without regenerating. The writer finish handshake can already have delivered the draft; still call this tool to get the final response. Never infer completion from the writer’s prose or preview link. Return the editor link, then any show_to_user text verbatim, open only if the returned open_when_ready is true, and ask whether the user wants to publish. Never call for a partial or interrupted writer.', {
    workspace: z.string().optional(), run_id: z.uuid(), completed: z.literal(true)
  }, async a => (await atWorkspace(a.workspace)).complete(a), false, true);
  tool('cancel_run', 'Release a generation run after the host agent has stopped. Does not stop processes or delete files. A writing run requires stopped=true.', { workspace: z.string().optional(), run_id: z.uuid(), stopped: z.boolean().optional() }, async a => (await atWorkspace(a.workspace)).cancel(a.run_id, a.stopped));
  tool('sync', 'Refresh remote project settings, articles and video walkthroughs, including remote-only resources, publication/sharing, review links and changes. Missing walkthroughs are unavailable, not confirmed deletion tombstones. Preserves local content and upload baselines. Review conflicts in the editor; never recreate deleted resources automatically.', { workspace: z.string().optional() }, async a => (await atWorkspace(a.workspace)).sync(), false, true, { destructiveHint: false });
  tool('list_walkthroughs', 'List existing hosted video walkthroughs, including videos created in the browser. Returns generation, readiness, sharing and article-publication state with review/playback links. Optional article_id filters to one article. For the next page pass both next_cursor as after_id and through_id. Does not generate or share videos.', {
    workspace: z.string().optional(), article_id: remoteId.optional(), after_id: remoteId.optional(), through_id: z.string().regex(/^\d+$/).optional(),
  }, async ({ workspace, ...input }) => new Walkthroughs(await atWorkspace(workspace, false)).list(input), true, true);
  tool('get_walkthrough', 'Read a hosted video walkthrough by ID: current generation and public visibility, revision, assets, transcript when available, and private review/playback links. Use get_operation for a Writer generation job; this tool also reads videos created outside Writer. Read-only: never publishes, shares or starts generation.', {
    workspace: z.string().optional(), walkthrough_id: remoteId,
  }, async a => new Walkthroughs(await atWorkspace(a.workspace, false)).get(a.walkthrough_id), true, true);
  tool('list_local_articles', 'List current local article files when signed out or in local mode, without login or network requests. Otherwise refresh the linked project inventory, including remote-only articles and conflicts. Preserves local content.', { workspace: z.string().optional() }, async a => (await atWorkspace(a.workspace, false)).listLocal(), false, true, { destructiveHint: false });
  tool('validate_article', 'Validate article schema, image references and available lint results. Validation does not finalize a generation run.', { artifact_dir: dir }, a => bridge.validate(a.artifact_dir), true);
  tool('preview_article', 'Create a self-contained local preview. Returns a file path and URI; no network requests or article scripts execute in the preview.', { artifact_dir: dir }, a => bridge.preview(a.artifact_dir));
  tool('finalize_article', 'Snapshot a successfully completed article for upload. Set completed=true only after the full skill pipeline succeeds (or after reviewing an existing finished article). Prepared runs require their run_id. Never finalize interrupted generation.', { artifact_dir: dir, completed: z.literal(true), run_id: z.uuid().optional(), section_id: remoteId.optional() }, a => bridge.finalize(a));
  tool('upload_draft', 'Upload the finalized article bundle to the bound SupportPages.io project as an unreviewed draft. Repeating an upload is safe. Published-article changes are rejected.', { slug: idSchema }, a => bridge.upload(a.slug), false, true);
  tool('get_article', 'Read remote content, revision and publication state for an article in the bound project.', { article_id: remoteId }, a => bridge.getArticle(a.article_id), true, true);
  const revision = z.string().regex(/^[a-f0-9]{64}$/);
  const addressed = { workspace: z.string().optional(), article_id: remoteId, expected_revision: revision };
  tool('list_articles', 'List existing support articles. By default, inspect local article files when signed out or in local mode; otherwise list the linked help centre. Do not call status or init first and do not ask for login for a local listing. An empty local result does not mean the hosted help centre is empty. Use source=hosted only for an explicitly hosted inventory request, or source=local to inspect local files while signed in. Hosted results use next_cursor as after_id.', {
    workspace: z.string().optional(), after_id: remoteId.optional(), source: z.enum(['auto', 'local', 'hosted']).default('auto'),
  }, async a => (await atWorkspace(a.workspace, false)).listArticles(a.after_id, a.source), true, true);
  tool('update_article', 'Save an exact content update using the current revision from get_article. Structured articles use structured_content; Markdown articles use body and optional title. Preserves images and publication state. Published changes become live immediately and require repository access and publish permission. On conflict read again; never overwrite browser changes.', {
    ...addressed, structured_content: z.record(z.string(), z.unknown()).optional(), body: z.string().max(200_000).optional(), title: z.string().max(200).optional(),
  }, async a => (await atWorkspace(a.workspace, false)).mutateArticle('update_article', a), false, true);
  tool('publish_article', 'Make an article visible in the hosted help centre. It can be unpublished again in the web editor or with unpublish_article. Use only when the user has instructed publication. Address by article_id and current revision, or use the legacy slug and uploaded bundle revision; never both.', {
    workspace: z.string().optional(), article_id: remoteId.optional(), slug: idSchema.optional(), expected_revision: revision,
  }, async a => {
    if (Boolean(a.article_id) === Boolean(a.slug)) fail('invalid_request', 'Supply either article_id or the legacy local slug.');
    const selected = await atWorkspace(a.workspace, false);
    return a.article_id ? selected.mutateArticle('publish_article', { article_id: a.article_id, expected_revision: a.expected_revision }) : selected.publish(a.slug!, a.expected_revision);
  }, false, true, { destructiveHint: false });
  tool('unpublish_article', 'Remove an article from the public help centre while retaining it as a draft. Requires an account and publish permission, not a repository. Use the latest revision.', addressed,
    async a => (await atWorkspace(a.workspace, false)).mutateArticle('unpublish_article', a), false, true);
  tool('delete_article', 'Soft-delete the selected article using its latest revision. Use only when the user requests deletion. Existing retention and browser restoration apply; never recreate it through upload or retry.', addressed,
    async a => (await atWorkspace(a.workspace, false)).mutateArticle('delete_article', a), false, true);
  return server;
}
