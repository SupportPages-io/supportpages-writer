import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { apiOrigin } from './api.js';
import { fail, SupportPagesError } from './errors.js';
import { connectionFailure } from './development-tls.js';

const hex = z.string().regex(/^[a-f0-9]{64}$/);
const startSchema = z.object({ pairing_id: hex, pairing_secret: hex, verification_uri: z.string(),
  user_code: z.string().regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/), expires_at: z.iso.datetime(), interval: z.number().int().min(3).max(60) });
const deliverySchema = z.object({ status: z.literal('authorized'), api_origin: z.string(),
  account: z.object({ id: z.string().regex(/^[1-9][0-9]*$/), email: z.string().max(320) }),
  token: z.string().regex(/^sp_local_[a-f0-9]{64}$/),
  scopes: z.array(z.enum(['read', 'import', 'projects:create', 'publish', 'manage', 'generate'])).min(3).max(6), token_expires_at: z.iso.datetime() });
export type Delivery = z.infer<typeof deliverySchema>;
export type Approval = { url: string; code: string; id: string };
export type PairingRuntime = { fetcher: typeof fetch; now: () => number; sleep: (ms: number) => Promise<void> };
const runtime: PairingRuntime = { fetcher: (...args) => fetch(...args), now: Date.now, sleep: ms => sleep(ms, undefined, { ref: false }) };
export const REQUIRED_SCOPES = ['read', 'import', 'projects:create'] as const;
/** Offered alongside the required ones at every sign-in. The approval page is
 * where the user decides what to grant; sending them back to the browser
 * mid-task for one more box is worse than one informed decision up front. */
export const OPTIONAL_SCOPES = ['publish', 'manage', 'generate'] as const;

/** Device sign-in. Bootstrap secrets and delivery responses never leave this native process. */
export class Pairing {
  private secret = '';
  private id = '';
  private deadline = 0;
  private interval = 3000;
  private stopped = false;
  private done?: Promise<void>;
  private failure?: unknown;
  private status = 'authentication_required';
  private approval?: Approval;
  private approvalOrigin: string;
  private requestedScopes: string[] = [];
  constructor(private origin: string, private dev: boolean, private rt: PairingRuntime = runtime) {
    this.origin = apiOrigin(origin, dev);
    this.approvalOrigin = this.origin;
  }
  /** `label` is the device name shown on the approval page (never a filesystem path). */
  async start(label: string, options: { client: 'SupportPages Writer' | 'SupportPages Writer MCP' }) {
    const device = [...label.replace(/[\p{Cc}\p{Cf}]/gu, '').trim()].slice(0, 100).join('') || 'This device';
    this.requestedScopes = [...REQUIRED_SCOPES, ...OPTIONAL_SCOPES];
    let raw: unknown;
    try {
      raw = await this.request('', { client_name: options.client, workspace_name: device,
        requested_scopes: this.requestedScopes });
    } catch (error) {
      if (error instanceof SupportPagesError && ['invalid_request', 'not_found'].includes(error.code)) fail('setup_unsupported', 'This SupportPages.io server does not support device sign-in yet. Ask its administrator to update it.');
      throw error;
    }
    const parsed = startSchema.safeParse(raw);
    if (!parsed.success) fail('invalid_response', 'The authorization service returned an invalid request.');
    const value = parsed.data;
    let approvalUrl: URL;
    try { approvalUrl = new URL(value.verification_uri); }
    catch { fail('invalid_response', 'The authorization service returned an invalid approval URL.'); }
    const transportUrl = new URL(this.origin);
    // Docker exposes native HTTP and canonical browser HTTPS on separate ports.
    // Only explicit dev mode permits this upgrade on the same local hostname.
    // All private requests continue to use the configured native API origin.
    const devUpgrade = this.dev && transportUrl.protocol === 'http:' &&
      approvalUrl.protocol === 'https:' && approvalUrl.hostname === transportUrl.hostname;
    if ((approvalUrl.origin !== this.origin && !devUpgrade) ||
        value.verification_uri !== `${approvalUrl.origin}/settings/mcp/connect/${value.pairing_id}` || value.pairing_secret === value.pairing_id) {
      fail('invalid_response', 'The authorization service returned an invalid approval URL.');
    }
    this.approvalOrigin = approvalUrl.origin;
    this.deadline = Date.parse(value.expires_at);
    if (this.deadline <= this.rt.now() || this.deadline > this.rt.now() + 11 * 60_000) fail('invalid_response', 'The authorization deadline is invalid.');
    this.id = value.pairing_id;
    this.secret = value.pairing_secret;
    this.interval = value.interval * 1000;
    this.approval = { url: value.verification_uri, code: value.user_code, id: value.pairing_id };
    return this.approval;
  }
  cancel() { this.stopped = true; this.secret = ''; this.status = 'authorization_cancelled'; }
  get finished() { return this.status !== 'authentication_required'; }
  result() {
    if (this.failure) throw this.failure;
    return { status: this.status, verification_uri: this.approval?.url, user_code: this.approval?.code,
      expires_at: new Date(this.deadline).toISOString(),
      instructions: this.status === 'authentication_required'
        ? 'Open the approval link in the user’s browser, compare the code, and approve sign-in for this device. The sign-in finishes automatically while this MCP stays running. Call supportpages_status to check progress. Never ask for a token or approve on the user’s behalf.'
        : 'Call supportpages_init again to continue.' };
  }
  run(save: (delivery: Delivery) => Promise<void>, completed?: () => Promise<void>) {
    if (this.done) return;
    this.done = this.deliver(save).then(async () => {
      if (this.stopped) return;
      this.status = 'ready';
      try { await completed?.(); } catch { /* The credential is already saved; notification is advisory. */ }
    }).catch(error => { this.failure = error; this.status = 'authorization_failed'; }).finally(() => { this.secret = ''; });
  }
  async wait(ms = 20_000) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([this.done, new Promise<void>(resolve => { timer = setTimeout(resolve, ms); timer.unref(); })]); }
    finally { if (timer) clearTimeout(timer); }
  }
  private async deliver(save: (delivery: Delivery) => Promise<void>) {
    let saved = false;
    while (!this.stopped && this.rt.now() < this.deadline) {
      await this.rt.sleep(Math.min(this.interval, this.deadline - this.rt.now()));
      if (this.stopped) return;
      if (this.rt.now() >= this.deadline) break;
      try {
        if (!saved) {
          const poll = z.object({ status: z.enum(['pending', 'approved', 'denied', 'expired', 'exchanged', 'completed']) }).safeParse(await this.request('/poll'));
          if (!poll.success) fail('invalid_response', 'Invalid authorization status.');
          if (poll.data.status === 'pending') continue;
          if (poll.data.status === 'denied') fail('authorization_denied', 'Sign-in was declined in the browser. Run supportpages login or call supportpages_init to start again.');
          if (poll.data.status === 'expired') break;
          if (poll.data.status === 'completed') fail('pairing_completed', 'This sign-in request was already completed. Start again to sign in.');
          const parsed = deliverySchema.safeParse(await this.request('/exchange'));
          if (!parsed.success) fail('invalid_response', 'The authorization service returned invalid credentials.');
          const value = parsed.data;
          if (value.api_origin !== this.approvalOrigin || REQUIRED_SCOPES.some(scope => !value.scopes.includes(scope)) ||
              value.scopes.some(scope => !this.requestedScopes.includes(scope)) ||
              new Set(value.scopes).size !== value.scopes.length || Date.parse(value.token_expires_at) <= this.rt.now()) {
            fail('invalid_response', 'The authorization service returned invalid permissions or origin.');
          }
          if (this.stopped) return;
          await save(value);
          saved = true;
        }
        if (this.stopped) return;
        const ack = await this.request('/acknowledge');
        if (!z.object({ status: z.literal('completed') }).safeParse(ack).success) fail('invalid_response', 'Invalid authorization acknowledgment.');
        return;
      } catch (error) {
        if (error instanceof SupportPagesError && ['network_error', 'rate_limited', 'service_unavailable', 'authorization_pending'].includes(error.code)) continue;
        // An expired delivery window cannot invalidate a credential already saved.
        if (saved && error instanceof SupportPagesError && error.code === 'pairing_expired') return;
        throw error;
      }
    }
    if (!this.stopped && !saved) fail('pairing_expired', 'The sign-in request expired. Run supportpages login or call supportpages_init to start again.');
  }
  private async request(action: string, body?: object, method = 'POST'): Promise<unknown> {
    let response: Response;
    try {
      response = await this.rt.fetcher(`${this.origin}/api/v1/mcp/pairings${action ? `/${this.id}${action}` : ''}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { Accept: 'application/json', ...(action ? { Authorization: `Bearer ${this.secret}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch (error) { connectionFailure(error, this.dev, 'SupportPages.io authorization could not be reached. Retry sign-in.'); }
    if (!response.ok) {
      const retry = response.headers.get('retry-after');
      const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : retry ? (Date.parse(retry) - this.rt.now()) / 1000 : 0;
      if (Number.isFinite(seconds)) this.interval = Math.max(this.interval, Math.min(660_000, seconds * 1000));
      await response.body?.cancel();
      const code = ({ 401: 'invalid_pairing', 403: 'permission_denied', 404: 'not_found', 422: 'invalid_request', 409: 'authorization_pending', 410: 'pairing_expired', 429: 'rate_limited', 503: 'service_unavailable' } as Record<number, string>)[response.status] ?? 'remote_error';
      fail(code, code === 'permission_denied' ? 'Sign-in was refused by SupportPages.io.' : `SupportPages.io authorization returned HTTP ${response.status}. Retry sign-in.`);
    }
    if (!response.headers.get('content-type')?.includes('application/json')) { await response.body?.cancel(); fail('invalid_response', 'Invalid authorization response.'); }
    const reader = response.body?.getReader();
    if (!reader) fail('invalid_response', 'Empty authorization response.');
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 16_384) { await reader.cancel(); fail('invalid_response', 'Authorization response exceeded its size limit.'); }
        chunks.push(chunk.value);
      }
    } catch (error) {
      if (error instanceof SupportPagesError) throw error;
      fail('network_error', 'The authorization response was interrupted.');
    } finally { reader.releaseLock(); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { fail('invalid_response', 'Invalid authorization response.'); }
  }
}
