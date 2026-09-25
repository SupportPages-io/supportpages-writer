import tls from 'node:tls';
import { fail } from './errors.js';

/** Development processes also trust CAs already approved in the OS trust store.
 * Keep Node's existing roots, including explicit NODE_EXTRA_CA_CERTS entries.
 * This changes only this process; it never installs certificates or disables TLS.
 */
export function configureDevelopmentTLS(origin: string, dev: boolean, certificates = tls): void {
  if (!dev) return;
  const url = new URL(origin);
  if (url.protocol !== 'https:' || !['localhost', '127.0.0.1', '[::1]', 'app.lvh.me'].includes(url.hostname)) return;
  // Older source runtimes can still use NODE_EXTRA_CA_CERTS at process startup.
  if (typeof certificates.getCACertificates !== 'function' || typeof certificates.setDefaultCACertificates !== 'function') return;
  const current = certificates.getCACertificates('default');
  const combined = [...new Set([...current, ...certificates.getCACertificates('system')])];
  if (combined.length !== new Set(current).size) certificates.setDefaultCACertificates(combined);
}

/** Do not expose fetch's raw cause: it can contain request data or proxy secrets. */
export function connectionFailure(error: unknown, dev: boolean, fallback: string): never {
  const value = error as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = value?.cause?.code ?? value?.code;
  if (typeof code === 'string') {
    if (['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT'].includes(code)) {
      fail('certificate_error', dev
        ? 'The development HTTPS certificate is not trusted. Install the local CA with mkcert -install and restart your coding client. For a custom CA or older Node runtime, configure NODE_EXTRA_CA_CERTS in the CLI and MCP server environment. Keep TLS verification enabled.'
        : 'The SupportPages.io HTTPS certificate could not be verified. Check the server certificate chain or your trusted network CA configuration. Keep TLS verification enabled.', { reason: code });
    }
    if (code === 'CERT_HAS_EXPIRED') fail('certificate_error', 'The HTTPS certificate has expired. Renew the certificate and retry.', { reason: code });
    if (code === 'ERR_TLS_CERT_ALTNAME_INVALID') fail('certificate_error', 'The HTTPS certificate does not match the configured API hostname. Check the API URL and certificate.', { reason: code });
  }
  fail('network_error', fallback);
}
