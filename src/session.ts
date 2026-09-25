import os from 'node:os';
import { resolveAction, type WriterAction } from './actions.js';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { lstat, rm } from 'node:fs/promises';
import { Workspace } from './workspace.js';
import { Bridge, analysisInstruction } from './bridge.js';
import { ApiClient, connectionStateRoot } from './api.js';
import { Runs } from './runs.js';
import { readCredential, readTokenFile, saveTokenFile, type Account, type Credential } from './credentials.js';
import { Pairing, type Approval, type Delivery, type PairingRuntime } from './pairing.js';
import { fail, publicError } from './errors.js';
import { replaceConnection } from './replace-connection.js';
import { configureDevelopmentTLS } from './development-tls.js';
import { openPreview } from './progress.js';

/** One credential per API origin: signing in covers every help centre the account can access. */
export function credentialLocation(origin: string, configDir: string) {
  const reference = createHash('sha256').update(origin).digest('hex').slice(0, 12);
  return { reference, filename: path.join(configDir, 'credentials', `${reference}.json`) };
}
export const defaultConfigDir = () => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'supportpages');
/** Bounded display label for the approval page; never a path. */
export function deviceLabel(hostname = os.hostname()) {
  return [...hostname.replace(/[\p{Cc}\p{Cf}]/gu, '').trim()].slice(0, 100).join('') || 'This device';
}
const LOGIN = '\0login';
export type LoginResult = { status: 'signed_in'; api_origin: string; account?: Account; already_signed_in?: boolean };
export type FormSchema = { type: 'object'; properties: Record<string, { type: 'string'; title?: string; description?: string; enum?: string[]; enumNames?: string[]; default?: string; minLength?: number; maxLength?: number }>; required?: string[] };
export type AccountOffer =
  | { status: 'unavailable' }
  | { status: 'declined'; asked: boolean }
  | { status: 'linked'; project_id: string; account?: Account }
  | ({ status: string } & Record<string, unknown>);
type InitializeInput = { workspace?: string; project_id?: string; host_local?: boolean; setup_action?: WriterAction; open_browser?: boolean; signup?: boolean; await_ms?: number };
export type HostedSetupInput = { workspace?: string; project_id?: string; signup?: boolean; action: 'find_article_gaps' | 'suggest_sections' | 'recommend_articles' | 'create_video_walkthrough'; article_id?: string; resume_arguments?: { article_id?: string; expected_revision?: string; request_id?: string; prefer_background?: boolean; open_when_ready?: boolean } };
export class Session {
  roots?: () => Promise<string[] | undefined>;
  private selected?: string;
  private pairings = new Map<string, Pairing>();
  private initializing = new Map<string, Promise<unknown>>();
  private hostedConnecting = new Map<string, Promise<Record<string, unknown>>>();
  private setupPages = new Map<string, Promise<boolean>>();
  openBrowser: (url: string) => Promise<boolean> = openPreview;
  approval?: (request: Approval) => Promise<'accept' | 'decline' | 'cancel' | 'unsupported'>;
  approvalCompleted?: (id: string) => Promise<void>;
  /** Form elicitation: the client renders the question itself, so the choice never
   * depends on how the model phrases it. Undefined when the client has no dialog. */
  askForm?: (message: string, requestedSchema: FormSchema) => Promise<{ action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> } | undefined>;
  private declinedAccount = new Set<string>();
  private bridges = new Map<string, { token?: string; bridge: Bridge }>();
  private closed = false;
  close() { for (const { bridge } of this.bridges.values()) bridge.close(); this.closed = true; for (const pairing of this.pairings.values()) pairing.cancel(); }
  constructor(public options: { workspace?: string; projectDir?: string; cwd: string; origin: string; dev: boolean; skillsDir: string; configDir: string; tokenFile?: string; token?: string; pairingRuntime?: PairingRuntime; callBudgetMs?: number }) {
    configureDevelopmentTLS(options.origin, options.dev);
  }
  async workspace(requested?: string) {
    const fixed = this.options.workspace ?? this.options.projectDir;
    const roots = fixed ? undefined : await this.roots?.();
    if (roots && roots.length === 0) fail('workspace_required', 'The client supplied no local workspace roots. Configure --workspace explicitly.');
    const candidates = fixed ? [fixed] : roots ?? [this.options.cwd];
    const canonical = await Promise.all(candidates.map(async root => (await Workspace.create(root)).root));
    const choice = requested ?? this.selected;
    if (choice) {
      const resolved = (await Workspace.create(choice)).root;
      if (!canonical.includes(resolved)) fail('invalid_workspace', 'Choose one of the workspace roots supplied by the client.', { roots: canonical });
      this.selected = resolved;
      return Workspace.create(resolved);
    }
    if (canonical.length !== 1) fail('workspace_required', 'Multiple workspace roots are available. Call supportpages_init with the intended workspace.', { roots: canonical });
    return Workspace.create(canonical[0]!);
  }
  /** Explicit token overrides win; otherwise the device credential for this origin; otherwise an inherited environment token. */
  private async credential(): Promise<Credential | undefined> {
    const o = this.options;
    if (o.tokenFile) return readCredential(o.tokenFile, o.origin);
    const { filename } = credentialLocation(o.origin, o.configDir);
    try { await lstat(filename); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return o.token ? { token: o.token } : undefined;
    }
    return readCredential(filename, o.origin);
  }
  async account(): Promise<Account | undefined> {
    try { return (await this.credential())?.account; } catch { return undefined; }
  }
  async bridge(ws?: Workspace, options: { resumeCompletion?: boolean } = {}) {
    ws ??= await this.workspace();
    const o = this.options;
    const token = (await this.credential())?.token;
    const key = ws.root;
    const existing = this.bridges.get(key);
    if (existing && existing.token === token) return existing.bridge;
    const bridge = new Bridge(ws, new ApiClient(o.origin, token, (...args) => fetch(...args), o.dev), o.skillsDir, undefined, undefined, o.configDir);
    // Invitation tools only inspect metadata. Do not arm a completion relay or
    // cache this passive instance in place of the normal session-owned bridge.
    if (options.resumeCompletion === false) return bridge;
    existing?.bridge.close();
    await bridge.resumeWriterCompletion();
    this.bridges.set(key, { token, bridge });
    return bridge;
  }
  /** Sign this device in. Reuses a working credential; otherwise runs browser approval and saves the delivered account token. */
  async login(input: { publish?: boolean; scopes?: ('publish' | 'manage' | 'generate')[]; onApproval?: (request: Approval) => Promise<void> } = {}): Promise<LoginResult> {
    const o = this.options;
    if (o.tokenFile || o.token) fail('invalid_configuration', 'Sign-in manages the saved device credential. Remove explicit token overrides first.');
    let existing: Credential | undefined;
    try { existing = await this.credential(); } catch { /* An unreadable file is replaced by a fresh sign-in. */ }
    if (existing) {
      try {
        const settings = await new ApiClient(o.origin, existing.token, fetch, o.dev).request('GET', '/mcp/settings') as { account?: Account; scopes?: string[] } | null;
        if (!input.scopes?.length || input.scopes.every(scope => settings?.scopes?.includes(scope))) return { status: 'signed_in', api_origin: o.origin, account: settings?.account ?? existing.account, already_signed_in: true };
        if (!settings?.scopes) fail('server_update_required', 'Update the server before requesting new permissions.');
        input.scopes = [...new Set([...input.scopes, ...settings.scopes.filter(scope => ['publish', 'manage', 'generate'].includes(scope))])] as ('publish' | 'manage' | 'generate')[];
      } catch (error) { if ((error as { code?: string }).code !== 'invalid_credentials') throw error; }
    }
    const pairing = new Pairing(o.origin, o.dev, o.pairingRuntime);
    const request = await pairing.start(deviceLabel(), { client: 'SupportPages Writer' });
    if (this.closed) { pairing.cancel(); fail('authorization_cancelled', 'Sign-in cancelled.'); }
    this.pairings.set(LOGIN, pairing);
    try {
      await input.onApproval?.(request);
      let delivery: Delivery | undefined;
      pairing.run(async value => { delivery = value; await this.saveCredential(value); });
      while (!pairing.finished) await pairing.wait(1000);
      if (pairing.result().status !== 'ready') fail('authorization_cancelled', 'Sign-in cancelled.');
      return { status: 'signed_in', api_origin: o.origin, account: delivery?.account };
    } finally { this.pairings.delete(LOGIN); }
  }
  /** A new request never expands the existing token. Only the explicit browser
   * grant can deliver a replacement credential. Declining keeps the old one. */
  async requestPermissions(input: { workspace?: string; action: WriterAction; article_id?: string; scopes: ('publish' | 'manage' | 'generate')[] }) {
    if (this.options.tokenFile || this.options.token) fail('permission_required', 'Update the explicitly configured token in SupportPages settings; browser consent cannot replace a token override.');
    const ws = await this.workspace(input.workspace);
    const decision = await resolveAction(await this.bridge(ws, { resumeCompletion: false }), input.action, input.article_id);
    if (decision.next_step?.code !== 'permission_required') return decision;
    const missing = decision.next_step.missing_scopes ?? [];
    if (missing.some(scope => !input.scopes.includes(scope as 'publish' | 'manage' | 'generate'))) fail('permission_required', 'Request every missing permission reported for this action.');
    const existing = this.pairings.get(ws.root);
    if (existing) {
      const result = existing.result();
      if (existing.finished) this.pairings.delete(ws.root);
      return { ...result, requested_action: input.action };
    }
    const credential = await this.credential();
    const settings = await new ApiClient(this.options.origin, credential?.token, fetch, this.options.dev).request('GET', '/mcp/settings') as { scopes?: string[]; account?: Account };
    if (!Array.isArray(settings?.scopes)) fail('server_update_required', 'Update the SupportPages server before requesting additional permissions.');
    const scopes = [...new Set([...settings.scopes.filter(scope => ['publish', 'manage', 'generate'].includes(scope)), ...input.scopes])] as ('publish' | 'manage' | 'generate')[];
    const pairing = new Pairing(this.options.origin, this.options.dev, this.options.pairingRuntime);
    const approval = await pairing.start(deviceLabel(), { client: 'SupportPages Writer MCP' });
    this.pairings.set(ws.root, pairing);
    pairing.run(async delivery => {
      if (settings.account && delivery.account.id !== settings.account.id) fail('account_mismatch', 'Approve permissions using the account already connected to this device.');
      await this.saveCredential(delivery);
    });
    return { ...pairing.result(), verification_uri: approval.url, user_code: approval.code, requested_action: input.action,
      instructions: 'Approve the requested permissions in your browser, then retry the original action. The existing credential is unchanged until consent completes.' };
  }
  async saveCredential(delivery: { token: string; account?: Account }) {
    const o = this.options;
    const { filename } = credentialLocation(o.origin, o.configDir);
    await saveTokenFile(filename, o.origin, delivery.token, delivery.account);
    for (const { bridge } of this.bridges.values()) await bridge.close();
    this.bridges.clear();
  }
  /** Active setup for an explicitly requested hosted action. Inspection tools
   * never call this: opening setup is not approval and never starts a job. */
  async setupHosted(input: HostedSetupInput): Promise<Record<string, unknown>> {
    const ws = await this.workspace(input.workspace);
    const key = ws.root;
    const running = this.hostedConnecting.get(key);
    if (running) { await running; return this.setupHosted(input); }
    const work = this.hostedSetup(input, ws);
    this.hostedConnecting.set(key, work);
    try { return await work; } finally { this.hostedConnecting.delete(key); }
  }
  /** Ask, in the client's own dialog, whether to sign in before a hosted request
   * the device cannot serve; then sign in, choose the help centre and link this
   * folder, all through dialogs. Declining is remembered for this session so the
   * user is not asked again unless they raise it. */
  async offerAccount(ws: Workspace, input: { need: string; explicit?: boolean }): Promise<AccountOffer> {
    if (!this.askForm) return { status: 'unavailable' };
    // An earlier "not now" silences unprompted offers, never a request the user just made.
    if (input.explicit) this.declinedAccount.delete(ws.root);
    else if (this.declinedAccount.has(ws.root)) return { status: 'declined', asked: false };
    // A coding client caps the whole tool call (60s in Claude Code, and progress
    // notifications do not extend it). Spend that budget on the dialogs and the
    // approval wait, and leave the rest of the flow to the next call.
    const deadline = Date.now() + (this.options.callBudgetMs ?? 50_000);
    const answer = await this.askForm(`${input.need} This device is not signed in to SupportPages.io. How would you like to continue?`, {
      type: 'object', required: ['account'],
      properties: { account: { type: 'string', title: 'SupportPages.io account', enum: ['sign_in', 'create_account', 'not_now'],
        enumNames: ['Sign in to my existing SupportPages.io account', 'Create a free SupportPages.io account', 'Not now — keep working without an account'] } } });
    if (!answer) return { status: 'unavailable' };
    const choice = answer.action === 'accept' ? answer.content?.account : undefined;
    if (choice !== 'sign_in' && choice !== 'create_account') { this.declinedAccount.add(ws.root); return { status: 'declined', asked: true }; }
    const auth = await this.authentication(ws, { host_local: true, signup: choice === 'create_account', open_browser: true,
      await_ms: Math.min(25_000, Math.max(0, deadline - Date.now() - 12_000)) }) as { status: string } & Record<string, unknown>;
    return this.linkAfterSignIn(ws, auth, deadline);
  }
  private async linkAfterSignIn(ws: Workspace, auth: { status: string } & Record<string, unknown>, deadline = Date.now() + 20_000): Promise<AccountOffer> {
    if (auth.status === 'ready') return { status: 'linked', project_id: String(auth.project_id), account: auth.account as Account | undefined };
    // Too little budget left to ask well: the next call asks instead of risking
    // a dialog the client cancels when the tool call times out.
    if (auth.status !== 'project_required' || !this.askForm || deadline - Date.now() < 8_000) return auth;
    const listed = auth.projects as { projects?: { id: string; name: string; help_centre_url?: string }[] } | undefined;
    const projects = listed?.projects ?? [];
    const answer = await this.askForm('Which help centre should this folder use?', {
      type: 'object', required: ['project'],
      properties: { project: { type: 'string', title: 'Help centre', enum: [...projects.map(project => project.id), 'new'],
        enumNames: [...projects.map(project => project.help_centre_url ? `${project.name} · ${project.help_centre_url}` : project.name), 'Create a new help centre'] } } });
    const pick = answer?.action === 'accept' ? answer.content?.project : undefined;
    if (typeof pick !== 'string' || pick !== 'new' && !projects.some(project => project.id === pick)) return auth;
    const bridge = await this.bridge(ws, { resumeCompletion: false });
    let projectId = pick;
    if (pick === 'new') {
      const suggested = path.basename(ws.root);
      const details = await this.askForm('Name the new help centre.', {
        type: 'object', required: ['name', 'subdomain'],
        properties: { name: { type: 'string', title: 'Help centre name', default: suggested, minLength: 1, maxLength: 100 },
          subdomain: { type: 'string', title: 'Address', description: 'Letters, digits and hyphens: <address>.supportpages.io', default: suggested.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63), minLength: 3, maxLength: 63 } } });
      const name = details?.action === 'accept' ? details.content?.name : undefined, subdomain = details?.action === 'accept' ? details.content?.subdomain : undefined;
      if (typeof name !== 'string' || typeof subdomain !== 'string') return auth;
      const created = await bridge.createProject(name.trim(), subdomain.trim().toLowerCase()) as { project?: { id?: string }; id?: string };
      projectId = String(created.project?.id ?? created.id);
    }
    await bridge.bind(projectId, { requireIdle: true });
    return { status: 'linked', project_id: projectId, account: auth.account as Account | undefined };
  }
  private async openSetupPage(url: string) {
    const target = new URL(url), origin = new URL(this.options.origin);
    if (target.username || target.password || (target.origin !== origin.origin && !(this.options.dev && origin.protocol === 'http:' && target.protocol === 'https:' && target.hostname === origin.hostname))) fail('invalid_response', 'The server returned an invalid setup link.');
    let opening = this.setupPages.get(url);
    if (!opening) {
      opening = this.openBrowser(url).catch(() => false);
      this.setupPages.set(url, opening);
    }
    return { browser_opened: await opening, browser_url: url };
  }
  private async hostedSetup(input: HostedSetupInput, ws: Workspace): Promise<Record<string, unknown>> {
    const next = { workspace: ws.root, action: input.action, ...(input.project_id ? { project_id: input.project_id } : {}), ...(input.article_id ? { article_id: input.article_id } : {}), ...(input.resume_arguments ? { resume_arguments: input.resume_arguments } : {}) };
    const base = { requested_action: input.action, next_tool: 'supportpages_setup_hosted', next_arguments: next, resume_tool: `supportpages_${input.action}`, resume_arguments: { workspace: ws.root, ...input.resume_arguments, ...(input.article_id ? { article_id: input.article_id } : {}) } };
    const authenticate = async () => {
      // With a client dialog the user chooses first; the sign-in that follows
      // also links the folder, so setup simply continues.
      const offered = await this.offerAccount(ws, { need: 'This request runs in SupportPages.io.' });
      if (offered.status === 'linked') return this.hostedSetup(input, ws);
      if (offered.status === 'declined') return { ...base, status: 'declined', instructions: 'The user chose not to sign in. Do not start setup or ask again unless they raise it.' };
      if (offered.status !== 'unavailable') return { ...offered, ...base, instructions: offered.status === 'authentication_required'
        ? 'Sign-in continues in the browser. Show the comparison code and browser_url if browser_opened is false; call supportpages_setup_hosted with next_arguments once approved.'
        : 'Sign-in finished but no help centre was chosen. Ask which help centre to use (or create one), then call supportpages_setup_hosted with next_arguments and its project_id.' };
      const result = await this.authentication(ws, { host_local: true, setup_action: input.action, open_browser: true, signup: input.signup }) as Record<string, unknown>;
      return { ...result, ...base, instructions: result.status === 'authorization_cancelled'
        ? 'Sign-in was cancelled. Retry setup only if the user requests it.'
        : result.status === 'signed_in' || result.status === 'ready'
        ? 'Sign-in is complete. Call supportpages_setup_hosted with next_arguments to continue the original request.'
        : 'First sign in or create an account in the opened browser and approve this device. Show the comparison code and use browser_url as a fallback if browser_opened is false. Do not ask to connect a repository yet. After approval, call supportpages_setup_hosted with next_arguments to continue the original request. Never approve consent for the user.' };
    };
    const pairing = this.pairings.get(ws.root);
    if (pairing) {
      if (!pairing.finished) return authenticate();
      this.pairings.delete(ws.root);
      const result = pairing.result();
      if (result.status !== 'ready') return { ...result, ...base, instructions: 'Browser consent was cancelled. Retry setup only if the user requests it.' };
    }
    let bridge: Bridge;
    try {
      bridge = await this.bridge(ws, { resumeCompletion: false });
      if (!bridge.api.configured()) return authenticate();
      // Validate sign-in before project selection. Never auto-select a project,
      // replace an existing binding, import local articles or run local analysis.
      const projects = await bridge.listProjects();
      if (input.project_id) {
        await bridge.bind(input.project_id, { requireIdle: true });
        delete next.project_id;
      }
      if (await bridge.destination() !== 'hosted') return { ...base, status: 'project_required', projects,
        instructions: 'Sign-in is complete. Ask which help centre to use; call supportpages_create_project if the user wants a new one, then call supportpages_setup_hosted with next_arguments and its project_id. Repository setup will open after selection. Do not call local init or start local analysis.' };
    } catch (error) {
      if (['invalid_credentials', 'invalid_credentials_file'].includes(publicError(error).code) && !this.options.token && !this.options.tokenFile) return authenticate();
      throw error;
    }
    const decision = await resolveAction(bridge, input.action, input.article_id);
    if (decision.next_step?.code === 'authentication_required') return authenticate();
    if (decision.next_step?.code === 'permission_required') {
      const scopes = (decision.next_step.missing_scopes ?? []).filter((scope): scope is 'publish' | 'manage' | 'generate' => ['publish', 'manage', 'generate'].includes(scope));
      const consent = await this.requestPermissions({ workspace: ws.root, action: input.action, article_id: input.article_id, scopes });
      return { ...base, ...consent, ...('verification_uri' in consent && consent.verification_uri ? await this.openSetupPage(consent.verification_uri) : {}),
        instructions: 'Approve the additional device permissions in the opened browser, then call supportpages_setup_hosted with next_arguments. The existing token is unchanged until you approve. Do not approve consent for the user.' };
    }
    return { ...base, ...decision, status: decision.allowed ? 'available' : 'action_required',
      ...(decision.next_step?.url ? await this.openSetupPage(decision.next_step.url) : {}),
      instructions: decision.allowed
        ? 'Setup is ready. Retry the original requested action with its original arguments. For a walkthrough, choose a completed hosted article using supportpages_list_articles with source=hosted if no article_id was supplied. Do not restore deleted local articles or upload one without an explicit request.'
        : `${decision.next_step?.message} ${decision.next_step?.url ? 'The required page has been opened if browser launch is available; otherwise show browser_url for the user to open. Complete this step there, then call supportpages_setup_hosted with next_arguments.' : 'Resolve this prerequisite before retrying.'} Preserve the original request; do not start local generation or unrelated jobs.` };
  }
  /** CLI-only: move this folder to another help centre after the user confirmed it. The device credential is untouched. */
  async switchProject(ws: Workspace, expectedProjectId: string, projectId: string) {
    if (this.options.tokenFile || this.options.token) fail('invalid_credentials_file', 'Remove the explicit token override before changing the connected help centre.');
    return replaceConnection(await this.bridge(ws), expectedProjectId, projectId);
  }
  async logout() {
    const o = this.options;
    if (o.tokenFile || o.token) fail('invalid_configuration', 'Logout manages the device credential. Remove explicit token overrides and revoke those tokens in SupportPages.io settings.');
    const { filename } = credentialLocation(o.origin, o.configDir);
    const result = { status: 'logged_out', api_origin: o.origin };
    try { await lstat(filename); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...result, already_logged_out: true }; throw error; }
    const token = await readTokenFile(filename, o.origin);
    try {
      const response = await new ApiClient(o.origin, token, fetch, o.dev).request('DELETE', '/mcp/session');
      if ((response as { status?: string } | null)?.status !== 'logged_out') fail('invalid_response', 'SupportPages.io did not confirm logout. Retry supportpages logout.');
    } catch (error) {
      // An expired/revoked credential is already unusable; retry after a lost
      // successful response also lands here. Keep credentials on network errors
      // so revocation can be retried rather than leaving an active token behind.
      if ((error as { code?: string }).code !== 'invalid_credentials') throw error;
    }
    // Do not remove a replacement credential saved while revocation was pending.
    try {
      if (await readTokenFile(filename, o.origin) !== token) fail('connection_changed', 'This device signed in again during logout. Its new credential was kept. Run supportpages logout again to revoke it.');
    } catch (error) {
      try { await lstat(filename); }
      catch (missing) { if ((missing as NodeJS.ErrnoException).code === 'ENOENT') return result; }
      throw error;
    }
    for (const { bridge } of this.bridges.values()) await bridge.close();
    this.bridges.clear();
    await rm(filename, { force: true });
    return result;
  }
  async status(input: { workspace?: string; run_id?: string } = {}) {
    const ws = await this.workspace(input.workspace);
    const article_run = await new Runs(ws, connectionStateRoot(this.options.origin, this.options.dev)).progress(input.run_id);
    const account = await this.account();
    const base = { workspace: ws.root, api_origin: this.options.origin, dev_mode: this.options.dev, account, article_run };
    const pairing = this.pairings.get(ws.root);
    if (pairing) {
      // Observing progress must not consume a terminal result or restart pairing.
      try {
        const result = pairing.result();
        if (result.status !== 'ready') return { ...base, ...result,
          status: result.status === 'authentication_required' ? 'approval_pending' : result.status,
          instructions: 'Complete the sign-in approval in your browser, then call supportpages_status to check progress. Call supportpages_init to start again after a cancelled request.' };
      } catch (error) {
        const safe = publicError(error);
        return { ...base, status: 'authorization_failed', error: safe,
          instructions: 'Call supportpages_init to clear the failed request, then call it again to sign in.' };
      }
    } else if (this.initializing.has(ws.root)) {
      return { ...base, status: 'connecting', instructions: 'Initialization is running. Call supportpages_status again shortly.' };
    }
    try { return { account, ...(await (await this.bridge(ws)).status(input.run_id)) }; }
    catch (error) {
      const safe = publicError(error);
      return { ...base, status: safe.code === 'invalid_credentials_file' ? 'authentication_required' : 'connection_error',
        error: safe, instructions: 'The saved device sign-in could not be used. Ask whether the user wants to sign in again, then call supportpages_init.' };
    }
  }
  private async authentication(ws: Workspace, input: InitializeInput = {}) {
    if (input.setup_action && (this.options.token || this.options.tokenFile)) fail('authentication_required', 'Replace the explicitly configured credential or remove the token override before signing in through the browser.');
    const o = this.options;
    const existing = this.pairings.get(ws.root);
    if (existing) {
      if (input.await_ms && !existing.finished) await existing.wait(input.await_ms);
      if (existing.finished && existing.result().status === 'ready') { this.pairings.delete(ws.root); return this.initialize(input, ws); }
      try {
        const result = existing.result();
        return { ...result, ...(input.open_browser && result.status === 'authentication_required' && result.verification_uri ? await this.openSetupPage(result.verification_uri) : {}) };
      }
      finally { if (existing.finished) this.pairings.delete(ws.root); }
    }
    const pairing = new Pairing(o.origin, o.dev, o.pairingRuntime);
    const request = await pairing.start(deviceLabel(), { client: 'SupportPages Writer MCP' });
    // The consent page signs in by default; a user who chose to create a free
    // account lands on registration instead (the same switch the terminal uses).
    if (input.signup) { const url = new URL(request.url); url.searchParams.set('signup', '1'); request.url = url.href; }
    if (this.closed) { pairing.cancel(); return pairing.result(); }
    this.pairings.set(ws.root, pairing);
    let action: 'accept' | 'decline' | 'cancel' | 'unsupported' = 'unsupported';
    try { action = await this.approval?.(request) ?? 'unsupported'; }
    catch { /* A client without working URL elicitation gets the same safe link. */ }
    if (action === 'decline' || action === 'cancel') { pairing.cancel(); this.pairings.delete(ws.root); return pairing.result(); }
    const browser = input.open_browser ? action === 'accept' ? { browser_opened: true, browser_url: request.url } : await this.openSetupPage(request.url) : {};
    pairing.run(async delivery => {
      await this.saveCredential(delivery);
    }, action === 'accept' ? () => this.approvalCompleted?.(request.id) ?? Promise.resolve() : undefined);
    if (action === 'accept' || input.await_ms) {
      // The user is at the approval page now, so hold the call briefly and
      // finish the whole flow rather than handing back a link to poll.
      await pairing.wait(action === 'accept' ? undefined : input.await_ms);
      if (pairing.finished) {
        try { pairing.result(); }
        finally { this.pairings.delete(ws.root); }
        return input.setup_action ? { status: 'signed_in', ...browser } : this.initialize(input, ws);
      }
    }
    return { ...pairing.result(), workspace: ws.root, api_origin: o.origin, ...browser };
  }
  async init(input: { workspace?: string; project_id?: string; signup?: boolean; host_local?: boolean }): Promise<unknown> {
    return this.connect(input);
  }
  /** MCP equivalent of the CLI's publish flow. Each response names the next user choice. */
  async publish(input: { workspace?: string; project_id?: string; slugs?: string[]; signup?: boolean } = {}) {
    const ws = await this.workspace(input.workspace);
    const initial = await this.bridge(ws);
    const inventory = await initial.lock(async () => {
      const destination = await initial.destination();
      if (destination === 'none') fail('project_required', 'This folder is not set up yet, so there are no saved articles to host. Call supportpages_init to link a help centre, or create an article first.');
      await initial.runs.assertAvailable();
      return { destination, articles: await initial.localArticles() };
    });
    if (!inventory.articles.length && !(inventory.destination === 'hosted' && input.slugs?.length)) {
      if (inventory.destination === 'hosted') return { status: 'up_to_date', uploaded: [], instructions: 'Every saved article in this folder is already on SupportPages.io.' };
      fail('nothing_to_publish', 'No saved articles to publish yet. Finish an article first.');
    }
    if (!initial.api.configured()) {
      const offered = await this.offerAccount(ws, { need: 'Hosting these articles needs a SupportPages.io help centre.', explicit: true });
      if (offered.status === 'declined') return { status: 'declined', articles: inventory.articles, instructions: 'The user chose not to sign in. No articles were uploaded and the folder keeps saving locally. Do not ask again unless they raise it.' };
    }
    const connection = await this.connect({ ...input, host_local: true }) as { status: string };
    if (connection.status !== 'ready') return { ...connection, articles: inventory.articles,
      instructions: connection.status === 'project_required'
        ? 'Ask which help centre to use, then call supportpages_publish with project_id and the selected article slugs. Use supportpages_create_project first if the user wants a new help centre.'
        : connection.status === 'authorization_cancelled'
        ? 'Sign-in was cancelled. No articles were uploaded and the folder was not connected. Call supportpages_publish again only if the user wants to retry.'
        : 'Show the browser approval link and comparison code if returned. The user must approve sign-in; never accept credentials in chat. Check supportpages_status, then call supportpages_publish again with the chosen project_id and slugs. No articles have been uploaded.' };
    return (await this.bridge(ws)).uploadLocalArticles(input.slugs);
  }
  private async connect(input: InitializeInput): Promise<unknown> {
    const ws = await this.workspace(input.workspace);
    const running = this.initializing.get(ws.root);
    if (running) return running;
    const work = this.initWorkspace(input, ws);
    this.initializing.set(ws.root, work);
    try { return await work; } finally { this.initializing.delete(ws.root); }
  }
  private async initWorkspace(input: InitializeInput, ws: Workspace): Promise<unknown> {
    const pairing = this.pairings.get(ws.root);
    if (pairing) {
      if (!pairing.finished) return this.authentication(ws, input);
      this.pairings.delete(ws.root);
      const result = pairing.result();
      if (result.status !== 'ready') return result;
    }
    return this.initialize(input, ws);
  }
  private async initialize(input: InitializeInput, ws: Workspace): Promise<unknown> {
    let bridge: Bridge;
    let projects: unknown;
    try {
      bridge = await this.bridge(ws);
      // A folder that saves articles locally needs no sign-in; an explicit
      // project_id still connects it to a help centre.
      if (!input.project_id && !input.host_local && await bridge.destination() === 'local') {
        const local = (await bridge.local())!;
        const analysis = await bridge.setup.analysis();
        return { status: 'local', workspace: bridge.ws.root, api_origin: this.options.origin, account: await this.account(),
          analysis, generation_ready: analysis.status === 'ready', export_dir: local.export_dir,
          instructions: [analysis.status === 'ready' ? undefined : analysisInstruction(analysis),
            analysis.status === 'ready'
              ? 'This folder saves articles locally as Markdown and screenshots; no help centre or sign-in is needed. Call supportpages_prepare_article to write one. If the user asks to host them or to use a help centre, ask whether to sign in or create a free SupportPages.io account, then call supportpages_init with host_local=true (signup=true for a new account); use supportpages_publish instead when the saved articles should be uploaded as well.'
              : 'This folder saves articles locally.'].filter(Boolean).join(' ') };
      }
      if (bridge.api.configured()) projects = await bridge.listProjects();
    } catch (error) {
      if (['invalid_credentials', 'invalid_credentials_file'].includes((error as { code?: string }).code ?? '') && !this.options.tokenFile) return this.authentication(ws, input);
      throw error;
    }
    const o = this.options;
    if (!bridge.api.configured()) return this.authentication(bridge.ws, input);
    if (input.project_id) await bridge.bind(input.project_id, { requireIdle: input.host_local });
    const bound = await bridge.ws.exists(`${bridge.stateRoot}/binding.json`) ? await bridge.binding() : undefined;
    if (!bound) {
      return { status: 'project_required', workspace: bridge.ws.root, api_origin: o.origin, account: await this.account(), projects,
        instructions: 'This device is signed in but the folder is not linked to a help centre yet. Ask the user which help centre it should use, then call supportpages_init again with that project_id. Call supportpages_create_project first to create a new help centre.' };
    }
    const analysis = await bridge.setup.analysis();
    const synchronization = await bridge.sync();
    return { status: 'ready', workspace: bridge.ws.root, api_origin: o.origin, account: await this.account(), project_id: bound.project_id,
      analysis, synchronization, generation_ready: analysis.status === 'ready',
      ...(analysis.status !== 'ready' ? { instructions: 'The connection is ready. Run supportpages analyse in this project’s terminal before creating an article.' } : {}) };
  }
}
