import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Telemetry, telemetryStatus, configureTelemetry, telemetryNotice } from '../dist/telemetry.js';
import { errorReport, scrubFrame, scrubText } from '../dist/telemetry-scrub.js';
import { SupportPagesError } from '../dist/errors.js';
import { localFixture } from './helpers.mjs';
import { mcp, result } from './scenario-helpers.mjs';

const origin = 'https://app.supportpages.io';
const env = {};
async function configDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'supportpages-telemetry-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
function recorder() {
  const calls = [];
  const fetcher = async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return new Response(null, { status: 202 }); };
  return { calls, fetcher, events: () => calls.flatMap(call => call.body.events) };
}

test('environment and preference opt-outs take precedence in order', () => {
  assert.deepEqual(telemetryStatus({}, {}), { enabled: true, reason: 'default' });
  assert.deepEqual(telemetryStatus({ SUPPORTPAGES_TELEMETRY: 'off' }, { telemetry: true }), { enabled: false, reason: 'SUPPORTPAGES_TELEMETRY' });
  assert.deepEqual(telemetryStatus({ DO_NOT_TRACK: '1', SUPPORTPAGES_TELEMETRY: '1' }, {}), { enabled: false, reason: 'DO_NOT_TRACK' });
  assert.deepEqual(telemetryStatus({ DO_NOT_TRACK: '0' }, {}), { enabled: true, reason: 'default' });
  assert.deepEqual(telemetryStatus({ CI: 'true' }, {}), { enabled: false, reason: 'CI' });
  assert.deepEqual(telemetryStatus({ CI: 'true', SUPPORTPAGES_TELEMETRY: '1' }, {}), { enabled: true, reason: 'default' });
  assert.deepEqual(telemetryStatus({}, { telemetry: false }), { enabled: false, reason: 'preference' });
});

test('the first run counts an install once, anonymously, without credentials', async t => {
  const dir = await configDir(t);
  const net = recorder();
  const first = new Telemetry({ configDir: dir, origin, env, fetcher: net.fetcher });
  first.setClient(() => 'claude-code');
  first.start();
  first.track('project_init', { location: 'local' });
  await first.drain();

  assert.equal(net.calls.length, 1);
  const [{ url, init, body }] = net.calls;
  assert.equal(url, `${origin}/api/v1/writer_telemetry`);
  assert.deepEqual(init.headers, { 'Content-Type': 'application/json' });
  assert.match(body.install_id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(body.events, [{ event: 'install' }, { event: 'project_init', properties: { location: 'local' } }]);
  assert.equal(body.context.host_client, 'claude-code');
  assert.equal(body.context.os, process.platform);
  const saved = JSON.parse(await readFile(path.join(dir, 'preferences.json'), 'utf8'));
  assert.equal(saved.install_id, body.install_id);

  const again = new Telemetry({ configDir: dir, origin, env, fetcher: net.fetcher });
  again.track('article_completed', { location: 'local', outcome: 'succeeded', duration_s: 90 });
  await again.drain();
  assert.equal(net.calls[1].body.install_id, body.install_id);
  assert.deepEqual(net.calls[1].body.events, [{ event: 'article_completed', properties: { location: 'local', outcome: 'succeeded', duration_s: 90 } }]);
});

test('property values other than codes and whole numbers are never sent', async t => {
  const net = recorder();
  const telemetry = new Telemetry({ configDir: await configDir(t), origin, env, fetcher: net.fetcher });
  telemetry.track('article_completed', { outcome: 'failed', error_code: 'The article "Secret plan" failed', duration_s: -3, location: 'local' });
  await telemetry.drain();
  assert.deepEqual(net.events().at(-1).properties, { outcome: 'failed', location: 'local' });
});

test('nothing is sent or stored when reporting is off, and turning it off drops queued events', async t => {
  const dir = await configDir(t);
  const net = recorder();
  const off = new Telemetry({ configDir: dir, origin, env: { SUPPORTPAGES_TELEMETRY: '0' }, fetcher: net.fetcher });
  off.start();
  off.track('project_init', { location: 'local' });
  off.error(new TypeError('boom'));
  await off.drain();
  assert.equal(net.calls.length, 0);
  await assert.rejects(readFile(path.join(dir, 'preferences.json')));

  const on = new Telemetry({ configDir: dir, origin, env, fetcher: net.fetcher });
  const changed = await on.setEnabled(false);
  assert.equal(changed.enabled, false);
  assert.match(changed.message, /now off/);
  on.track('project_init', { location: 'local' });
  await on.drain();
  assert.equal(net.calls.length, 0);

  const overridden = await new Telemetry({ configDir: dir, origin, env: { DO_NOT_TRACK: '1' } }).setEnabled(true);
  assert.equal(overridden.enabled, false);
  assert.match(overridden.message, /DO_NOT_TRACK/);
});

test('network failures never reach the caller', async t => {
  const telemetry = new Telemetry({ configDir: await configDir(t), origin, env, fetcher: async () => { throw new Error('offline'); } });
  telemetry.track('project_init', { location: 'hosted' });
  telemetry.error(new Error('x'));
  await telemetry.drain();
});

test('only unexpected errors are reported, scrubbed, once per fingerprint', async t => {
  const net = recorder();
  const installRoot = '/opt/supportpages/mcp';
  const telemetry = new Telemetry({ configDir: await configDir(t), origin, env, fetcher: net.fetcher, installRoot });
  telemetry.error(new SupportPagesError('plan_limit', 'Upgrade to write more.'));
  telemetry.error(new SupportPagesError('authentication_required', 'Sign in.'));
  const crash = new TypeError(`Cannot read properties of undefined reading "${os.homedir()}/acme/secret.md"`);
  crash.stack = `TypeError: ${crash.message}\n    at complete (${installRoot}/dist/bridge.js:535:12)\n    at render (${os.homedir()}/acme/node_modules/x/index.js:1:2)\n    at node:internal/process/task_queues:95:5`;
  telemetry.error(crash, 'complete_article');
  telemetry.error(crash, 'complete_article');
  await telemetry.drain();

  const errors = net.events().filter(event => event.event === 'error');
  assert.equal(errors.length, 1);
  assert.deepEqual(errors[0].properties, { error_code: 'internal_error', error_class: 'TypeError', tool: 'complete_article' });
  assert.equal(errors[0].error.message, undefined, 'foreign exception messages can quote user data');
  assert.deepEqual(errors[0].error.frames, ['complete (writer/dist/bridge.js:535:12)', 'render (<external>:1:2)', 'node:internal/process/task_queues:95:5']);
});

test('our own error messages are scrubbed of credentials, emails, URLs and home paths', () => {
  const report = errorReport(new SupportPagesError('remote_error', `Upload to https://app.supportpages.io/p/1?token=x for sam@example.com failed with sp_local_${'a'.repeat(64)} in ${os.homedir()}/acme`));
  assert.equal(report.message, 'Upload to https://app.supportpages.io for [email] failed with [token] in ~/acme');
  assert.equal(scrubText(`Bearer ${'f'.repeat(40)}`, 100), 'Bearer [token]');
  assert.equal(scrubFrame('    at x (C:\\Users\\sam\\app\\a.js:1:2)'), 'x (<external>:1:2)');
});

test('the disclosure is shown exactly once, and not at all when reporting is off', async t => {
  const dir = await configDir(t);
  const telemetry = new Telemetry({ configDir: dir, origin, env });
  assert.equal(await telemetry.notice(), telemetryNotice);
  assert.equal(await telemetry.notice(), undefined);
  assert.equal(await new Telemetry({ configDir: await configDir(t), origin, env: { CI: '1' } }).notice(), undefined);
});

test('the Writer counts a new local project and reports tool crashes with the client name', async t => {
  const net = recorder();
  const dir = await configDir(t);
  configureTelemetry({ configDir: dir, origin, env, fetcher: net.fetcher });
  t.after(() => configureTelemetry(undefined));
  const telemetry = (await import('../dist/telemetry.js')).activeTelemetry();

  const f = await localFixture(t);
  f.bridge.doctor = async () => { throw new RangeError('doctor exploded'); };
  const call = await mcp(t, f.bridge);
  const failed = await call('doctor');
  assert.equal(failed.isError, true);
  const disabled = result(await call('set_telemetry', { enabled: false }));
  assert.equal(disabled.enabled, false);
  await telemetry.drain();

  const events = net.events();
  assert.deepEqual(events.map(event => event.event), ['install', 'project_init', 'error']);
  assert.deepEqual(events[1].properties, { location: 'local' });
  assert.deepEqual(events[2].properties, { error_code: 'internal_error', error_class: 'RangeError', tool: 'doctor' });
  assert.equal(net.calls.at(-1).body.context.host_client, 'scenario-test');
});
