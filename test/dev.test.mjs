import test from 'node:test';
import assert from 'node:assert/strict';
import { apiOrigin, developmentMode, connectionStateRoot, ApiClient } from '../dist/api.js';

test('development origins are explicit and restricted to the local RTFM hosts', async () => {
  assert.equal(apiOrigin('http://app.lvh.me:3000', true), 'http://app.lvh.me:3000');
  assert.equal(apiOrigin('https://app.lvh.me:3443', true), 'https://app.lvh.me:3443');
  for (const host of ['localhost', '127.0.0.1', '[::1]']) assert.equal(apiOrigin(`http://${host}:3000`, true), `http://${host}:3000`);
  for (const url of ['http://app.lvh.me:3000', 'http://example.com']) assert.throws(() => apiOrigin(url), { code: 'invalid_configuration' });
  for (const url of ['https://app.supportpages.io', 'http://app.lvh.me.evil.example', 'http://user:secret@app.lvh.me:3000', 'http://app.lvh.me:3000/api', 'http://app.lvh.me:3000?token=secret']) assert.throws(() => apiOrigin(url, true), { code: 'invalid_configuration' });
  assert.equal(developmentMode('1'), true);
  assert.equal(developmentMode('false'), false);
  assert.throws(() => developmentMode('yes'), { code: 'invalid_configuration' });
  assert.notEqual(connectionStateRoot('http://app.lvh.me:3000', true), connectionStateRoot('http://app.lvh.me:4000', true));
  assert.equal(connectionStateRoot('https://app.supportpages.io', false), '.rtfm/supportpages');
  await assert.rejects(new ApiClient('http://app.lvh.me:3000', undefined, fetch, true).request('GET', '/projects'), { code: 'missing_credentials' });
});
