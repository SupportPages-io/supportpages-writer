import { createHash } from 'node:crypto';
import { fail } from './errors.js';
import { articleCapacitySchema } from './schema.js';
import { capacityMessage, type ArticleCapacity } from './capacity.js';
import { connectionFailure } from './development-tls.js';
export function developmentMode(value?: string): boolean {
  if (value === undefined || value === 'false' || value === '0') return false;
  if (value === 'true' || value === '1') return true;
  fail('invalid_configuration', 'SUPPORTPAGES_DEV must be true, false, 1 or 0.');
}
export function defaultOrigin(dev: boolean): string {
  return dev ? 'https://app.lvh.me:3443' : 'https://app.supportpages.io';
}
export function connectionStateRoot(origin: string, dev: boolean): string {
  return dev ? `.rtfm/supportpages/dev/${createHash('sha256').update(origin).digest('hex').slice(0, 16)}` : '.rtfm/supportpages';
}
export function apiOrigin(value: string, dev = false): string {
  let url: URL;
  try { url = new URL(value); } catch { fail('invalid_configuration', 'SUPPORTPAGES_API_URL must be an HTTP(S) origin.'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const local = loopback || url.hostname === 'app.lvh.me';
  if (dev && !local) fail('invalid_configuration', 'Dev mode requires localhost, loopback, or app.lvh.me.');
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && (loopback || (dev && local)))) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    fail('invalid_configuration', 'Use an HTTPS API origin, or HTTP on loopback (app.lvh.me requires --dev), without credentials or a path.');
  }
  return url.origin;
}
export class ApiClient {
  public origin: string;
  constructor(origin: string, private token?: string, private fetcher: typeof fetch = fetch, public dev = false) { this.origin = apiOrigin(origin, dev); }
  configured() { return Boolean(this.token); }
  async request(method: string, route: string, body?: FormData | object, idempotencyKey?: string, timeoutMs = 60_000): Promise<unknown> {
    if (!this.token) fail('missing_credentials', 'This device is not signed in to SupportPages.io. In the terminal, run supportpages publish to host locally saved articles, or supportpages login; then call supportpages_init.');
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}`, Accept: 'application/json' };
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    let payload: BodyInit | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    let response: Response;
    try { response = await this.fetcher(`${this.origin}/api/v1${route}`, { method, headers, body: payload, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) }); }
    catch (error) { connectionFailure(error, this.dev, 'SupportPages.io could not be reached. Check the connection and retry.'); }
    if (!response.ok) {
      const code = ({401: 'invalid_credentials', 403: 'permission_denied', 404: 'not_found', 409: 'revision_conflict', 413: 'bundle_too_large', 422: 'invalid_artifact', 429: 'rate_limited'} as Record<number, string>)[response.status] ?? 'remote_error';
      // Decode only bounded, recognised error codes. Never echo arbitrary server
      // messages, proxy diagnostics or user-controlled response fields.
      const known: Record<string, { status: number; message: string }> = {
        invalid_content: { status: 422, message: 'The supplied article content is invalid. Read the article and preserve its content format before retrying.' },
        unsupported_article_format: { status: 422, message: 'Preserve this article’s content format: structured content for illustrated articles, Markdown for API-authored articles.' },
        generation_running: { status: 409, message: 'Wait for the current generation to finish, or keep the local preview as an editable draft in SupportPages.' },
        article_deleted: { status: 409, message: 'This article was deleted remotely. Restore it in SupportPages.io before updating it; it will not be recreated automatically.' },
        plan_limit: { status: 403, message: 'Your account’s article hosting limit has been reached. Free up article capacity or update your plan, then retry the saved upload. Reconnecting will not resolve this limit.' },
        permission_denied: { status: 403, message: 'This token does not have permission for the requested operation. Check its scopes and project access; reconnect with supportpages init if needed.' },
        repository_connection_required: { status: 403, message: 'Connect a repository in the web app before assigning sections. Individual unsectioned articles do not require a repository connection.' },
        run_closed: { status: 409, message: 'This generation attempt is closed. The saved draft and your local files are preserved; do not overwrite browser edits.' },
        published_article: { status: 409, message: 'This article is already published. Local uploads cannot overwrite it; review it in the web app.' },
      };
      const reader = response.body?.getReader();
      let recognised: string | undefined;
      let capacity: ArticleCapacity | undefined;
      try {
        const chunks: Uint8Array[] = []; let size = 0;
        if (reader) while (size <= 8192) {
          const item = await reader.read();
          if (item.done) break;
          size += item.value.length;
          if (size <= 8192) chunks.push(item.value);
        }
        const value = size <= 8192 ? JSON.parse(Buffer.concat(chunks).toString()) : null;
        const candidate = value?.error?.code;
        if (typeof candidate === 'string' && Object.hasOwn(known, candidate) && known[candidate]?.status === response.status) recognised = candidate;
        if (recognised === 'plan_limit') {
          const parsed = articleCapacitySchema.safeParse(value?.error?.details?.article_capacity);
          if (parsed.success && !parsed.data.can_create) capacity = parsed.data;
        }
      } catch { /* Older servers and HTML errors retain their HTTP fallback. */ }
      finally { await reader?.cancel().catch(() => {}); reader?.releaseLock(); }
      if (recognised) {
        if (capacity) fail(recognised, `${capacityMessage(capacity)} Then retry the saved upload; no regeneration is needed.`, { status: response.status, article_capacity: capacity });
        const message = recognised === 'plan_limit' && !/\/(article_imports|generation_runs)(\/|$)/.test(route)
          ? 'Your account’s plan limit for this operation has been reached. Check your plan and available capacity before retrying.'
          : known[recognised]!.message;
        fail(recognised, message, { status: response.status });
      }
      fail(code, `SupportPages.io returned HTTP ${response.status}.`, { status: response.status });
    }
    if (!response.headers.get('content-type')?.includes('application/json')) fail('invalid_response', 'The API did not return JSON. Verify the RTFM integration is installed on the app host.');
    const reader = response.body?.getReader();
    if (!reader) fail('invalid_response', 'The API returned an empty response.');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 4 * 1024 * 1024) {
          await reader.cancel();
          fail('invalid_response', 'The API response exceeded the size limit.');
        }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
    const data = Buffer.concat(chunks).toString('utf8');
    try { return JSON.parse(data); } catch { fail('invalid_response', 'The API returned malformed JSON.'); }
  }
}
