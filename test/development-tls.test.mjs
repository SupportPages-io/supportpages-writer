import test from 'node:test';
import assert from 'node:assert/strict';
import { configureDevelopmentTLS } from '../dist/development-tls.js';
import { ApiClient } from '../dist/api.js';
import { Pairing } from '../dist/pairing.js';

test('local development HTTPS adds OS trust while preserving bundled and explicit roots', () => {
  let roots = ['bundled root', 'explicit extra root'];
  const changes = [];
  const certificates = {
    getCACertificates: type => type === 'default' ? roots : ['system mkcert root', 'bundled root'],
    setDefaultCACertificates: next => { roots = next; changes.push(next); },
  };
  configureDevelopmentTLS('https://app.lvh.me:3443', true, certificates);
  assert.deepEqual(roots, ['bundled root', 'explicit extra root', 'system mkcert root']);
  configureDevelopmentTLS('https://app.lvh.me:3443', true, certificates);
  assert.equal(changes.length, 1);
});

test('production, nonlocal and HTTP connections never change process trust', () => {
  const certificates = { getCACertificates: () => assert.fail('Must not read OS roots'), setDefaultCACertificates: () => assert.fail('Must not change trust') };
  for (const [origin, dev] of [['https://app.supportpages.io', false], ['https://app.lvh.me:3443', false], ['https://example.com', true], ['http://localhost:3000', true]]) configureDevelopmentTLS(origin, dev, certificates);
  // Source runtimes predating the Node API can keep using NODE_EXTRA_CA_CERTS.
  configureDevelopmentTLS('https://localhost:3443', true, {});
});

test('API and sign-in report certificate failures without leaking raw diagnostics', async () => {
  for (const [reason, message] of [['UNABLE_TO_VERIFY_LEAF_SIGNATURE', /mkcert -install/], ['CERT_HAS_EXPIRED', /expired/], ['ERR_TLS_CERT_ALTNAME_INVALID', /hostname/]]) {
    const fetcher = async () => { throw Object.assign(new Error('private request secret'), { cause: { code: reason, message: 'private proxy secret' } }); };
    const api = new ApiClient('https://app.lvh.me:3443', 'private token', fetcher, true);
    const pairing = new Pairing('https://app.lvh.me:3443', true, { fetcher, now: Date.now, sleep: async () => {} });
    for (const operation of [() => api.request('GET', '/projects'), () => pairing.start('test', { client: 'SupportPages Writer', publish: false })]) {
      await assert.rejects(operation(), error => {
        assert.equal(error.code, 'certificate_error');
        assert.match(error.message, message);
        assert.deepEqual(error.details, { reason });
        assert.doesNotMatch(JSON.stringify(error), /private/);
        return true;
      });
    }
    const production = new ApiClient('https://app.supportpages.io', 'private token', fetcher);
    await assert.rejects(production.request('GET', '/projects'), error => error.code === 'certificate_error' && !error.message.includes('mkcert'));
  }
  const offline = new ApiClient('https://app.lvh.me:3443', 'token', async () => { throw Error('private network diagnostics'); }, true);
  await assert.rejects(offline.request('GET', '/projects'), error => error.code === 'network_error' && !error.message.includes('bundle') && !error.message.includes('private'));
});
