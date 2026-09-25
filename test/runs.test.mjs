import test from 'node:test';
import assert from 'node:assert/strict';
import { analysedFixture as fixture, context, remote, article } from './helpers.mjs';
import { Bridge } from '../dist/bridge.js';
import { ApiClient } from '../dist/api.js';
import { createServer } from '../dist/server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
const input = { title: 'Invite', article_type: 'how-to' };
async function runFixture(t, handler) {
  const calls = [];
  const f = await fixture(t, async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/context')) return Response.json(context);
    if (url.endsWith('/projects')) return Response.json({ projects: [context.project] });
    if (handler) return handler(url, options);
    if (url.endsWith('/publish')) return Response.json({ ...remote, status: 'published', public_url: 'https://example.supportpages.io/invite' });
    return Response.json({ import_id: '7', article: remote });
  });
  await f.bridge.bind('1');
  return { ...f, calls };
}
test('host background run produces a draft, survives status checks, and completion is idempotent', async t => {
  const f = await runFixture(t);
  await f.bridge.repositoryReminders(false);
  const prepared = await f.bridge.prepare({ ...input, open_when_ready: true });
  assert.equal(prepared.status, 'prepared'); assert.equal(prepared.prefer_background, true);
  assert.equal(prepared.task_brief.workspace, f.root);
  assert.equal(prepared.task_brief.name, 'SupportPages.io');
  const writerContext = await f.ws.json(`${f.bridge.stateRoot}/runs/${prepared.run_id}/context.json`);
  assert.equal(writerContext.writing_style, context.writing_style);
  assert.match(prepared.instructions.join(' '), /subagent_type="supportpages-io"/);
  assert.match(prepared.task_brief.instructions.join(' '), /Do not call MCP tools/);
  assert.equal((await f.bridge.status()).article_run.phase, 'prepared');
  await f.bridge.updateRun({ run_id: prepared.run_id, event: 'started', execution_mode: 'background', host_task_id: 'task-42' });
  const status = await f.bridge.status(prepared.run_id);
  assert.equal(status.article_run.phase, 'writing'); assert.equal(status.article_run.progress_source, 'last_reported');
  assert.equal(status.article_run.host_task_id, 'task-42'); assert.equal(status.article_run.session_current, true);
  await f.output();
  const done = await f.bridge.complete({ run_id: prepared.run_id, completed: true });
  assert.equal(done.status, 'ready_for_review'); assert.equal(done.editor_url, remote.editor_url);
  assert.equal(done.open_when_ready, true); assert.match(done.instructions.join(' '), /Would you like me to publish it/);
  assert.equal(f.calls.filter(c => c.url.endsWith('/publish')).length, 0);
  const before = f.calls.filter(call => call.options.method === 'POST').length;
  assert.deepEqual(await f.bridge.complete({ run_id: prepared.run_id, completed: true }), { ...done, repository_connection: undefined });
  assert.equal(f.calls.filter(call => call.options.method === 'POST').length, before);
  assert.equal((await f.bridge.status()).article_run.editor_url, remote.editor_url);
  await f.bridge.publish('invite', remote.revision);
  assert.equal((await f.bridge.status()).article_run.phase, 'published');
  assert.equal((await f.bridge.complete({ run_id: prepared.run_id, completed: true })).status, 'published');
});
test('foreground fallback uses the same lifecycle and never defaults to browser opening', async t => {
  const f = await runFixture(t); const run = await f.bridge.prepare(input);
  assert.match(run.instructions.join(' '), /foreground/);
  assert.equal((await f.bridge.status()).article_run.phase, 'prepared');
  await f.bridge.updateRun({ run_id: run.run_id, event: 'started', execution_mode: 'foreground' });
  await f.output(); const result = await f.bridge.complete({ run_id: run.run_id, completed: true });
  assert.equal(result.open_when_ready, false); assert.match(result.instructions.join(' '), /Do not open a browser/);
});
test('a restart shows last-reported progress without automatically launching or clearing the writer', async t => {
  const f = await runFixture(t); const run = await f.bridge.prepare(input);
  await f.bridge.updateRun({ run_id: run.run_id, event: 'started', execution_mode: 'background' });
  const restarted = new Bridge(f.ws, f.bridge.api, f.bridge.skillsDir, 'different-session');
  const before = await f.ws.json(`${f.bridge.stateRoot}/runs/${run.run_id}/run.json`);
  const progress = (await restarted.status()).article_run;
  assert.equal(progress.phase, 'writing'); assert.equal(progress.session_current, false);
  assert.match(progress.instructions, /Verify the host task/);
  assert.deepEqual(await f.ws.json(`${f.bridge.stateRoot}/runs/${run.run_id}/run.json`), before);
  await assert.rejects(restarted.prepare({ ...input, title: 'Other' }), { code: 'generation_active' });
});
test('writers are serialized across development and production origins', async t => {
  const f = await runFixture(t); await f.bridge.prepare(input);
  const dev = new Bridge(f.ws, new ApiClient('http://app.lvh.me:3000', 'test-secret', async url => url.endsWith('/mcp/settings') ? new Response('', {status:404}) : Response.json(context), true), f.bridge.skillsDir);
  await dev.bind('1');
  await assert.rejects(dev.prepare({ ...input, title: 'Other' }), { code: 'generation_active' });
  await assert.rejects(dev.finalize({ artifact_dir: 'output/articles/other', completed: true }), { code: 'generation_active' });
});
test('cancellation and failure require stopped confirmation and cannot deliver partial output', async t => {
  for (const event of ['cancelled', 'failed', 'interrupted']) {
    const f = await runFixture(t); const run = await f.bridge.prepare(input);
    await f.bridge.updateRun({ run_id: run.run_id, event: 'started', execution_mode: 'background', host_task_id: 'a' });
    await assert.rejects(f.bridge.updateRun({ run_id: run.run_id, event }), { code: 'writer_not_stopped' });
    await assert.rejects(f.bridge.cancel(run.run_id), { code: 'writer_not_stopped' });
    await assert.rejects(f.bridge.updateRun({ run_id: run.run_id, event: 'started', execution_mode: 'foreground' }), { code: 'writer_not_stopped' });
    await f.output();
    await f.bridge.updateRun({ run_id: run.run_id, event, stopped: true });
    await assert.rejects(f.bridge.complete({ run_id: run.run_id, completed: true }), { code: 'incomplete_generation' });
    assert.equal(f.calls.filter(c => c.url.endsWith('/article_imports')).length, 0);
    assert.equal((await f.bridge.prepare({ ...input, title: 'Next' })).status, 'prepared');
  }
});
test('permission-blocked background writer can fall back to foreground after being stopped', async t => {
  const f = await runFixture(t); const run = await f.bridge.prepare(input);
  await f.bridge.updateRun({ run_id: run.run_id, event: 'started', execution_mode: 'background', host_task_id: 'a' });
  await f.bridge.updateRun({ run_id: run.run_id, event: 'started', execution_mode: 'foreground', stopped: true });
  assert.equal((await f.bridge.status()).article_run.host_task_id, undefined);
  await f.output(); assert.equal((await f.bridge.complete({ run_id: run.run_id, completed: true })).status, 'ready_for_review');
});
test('validation failure retains a retryable run and never uploads it', async t => {
  const f = await runFixture(t); const run = await f.bridge.prepare(input); await f.output();
  await f.ws.writeJson(`${run.artifact_dir}/lint_report.json`, { all_passed: false });
  await assert.rejects(f.bridge.complete({ run_id: run.run_id, completed: true }), { code: 'quality_check_failed' });
  assert.equal((await f.bridge.status()).article_run.phase, 'failed');
  assert.equal(f.calls.filter(c => c.url.endsWith('/article_imports')).length, 0);
  await f.output(); assert.equal((await f.bridge.complete({ run_id: run.run_id, completed: true })).status, 'ready_for_review');
});
test('lost upload response retries the immutable bundle without regenerating or changing idempotency identity', async t => {
  const uploads = [];
  const f = await runFixture(t, (_url, options) => {
    uploads.push({ key: options.headers['Idempotency-Key'], body: options.body.get('article') });
    if (uploads.length === 1) throw new Error('network lost');
    return Response.json({ import_id: '7', article: remote });
  });
  const run = await f.bridge.prepare(input); await f.output();
  await assert.rejects(f.bridge.complete({ run_id: run.run_id, completed: true }), { code: 'network_error' });
  const failed = await f.bridge.runs.read(run.run_id); assert.equal(failed.status, 'finalized');
  await f.output({ ...article, title: 'Changed after snapshot' });
  await f.bridge.complete({ run_id: run.run_id, completed: true });
  assert.equal(uploads.length, 2); assert.equal(uploads[0].key, uploads[1].key);
  assert.equal(await uploads[0].body.text(), await uploads[1].body.text());
});
test('completion recovers from article-state persistence before run-state persistence', async t => {
  const f = await runFixture(t); const run = await f.bridge.prepare(input); await f.output();
  await f.bridge.finalize({ artifact_dir: run.artifact_dir, run_id: run.run_id, completed: true });
  const finalized = await f.bridge.runs.read(run.run_id);
  await f.bridge.upload('invite');
  await f.bridge.lock(() => f.bridge.runs.save(finalized));
  const calls = f.calls.filter(call => call.options.method === 'POST').length;
  assert.equal((await f.bridge.complete({ run_id: run.run_id, completed: true })).editor_url, remote.editor_url);
  assert.equal(f.calls.filter(call => call.options.method === 'POST').length, calls);
});
test('an old finalized run cannot upload a replacement snapshot or target a different project', async t => {
  const f = await runFixture(t); const run = await f.bridge.prepare(input); await f.output();
  await f.bridge.finalize({ artifact_dir: run.artifact_dir, run_id: run.run_id, completed: true });
  await f.output({ ...article, title: 'Replacement' });
  await f.bridge.finalize({ artifact_dir: run.artifact_dir, completed: true });
  await assert.rejects(f.bridge.complete({ run_id: run.run_id, completed: true }), { code: 'stale_artifact' });
  await f.ws.writeJson(`${f.bridge.stateRoot}/binding.json`, { version: 1, api_origin: f.bridge.api.origin, project_id: '2' });
  await assert.rejects(f.bridge.complete({ run_id: run.run_id, completed: true }), { code: 'destination_mismatch' });
});
test('publish failure preserves the review link and does not re-upload browser edits', async t => {
  let published = 0, uploads = 0;
  const f = await runFixture(t, (url) => {
    if (url.endsWith('/publish')) { published++; return new Response('', { status: published === 1 ? 403 : 409 }); }
    uploads++; return Response.json({ import_id: '7', article: remote });
  });
  const run = await f.bridge.prepare(input); await f.output(); const done = await f.bridge.complete({ run_id: run.run_id, completed: true });
  await assert.rejects(f.bridge.publish('invite', done.article.revision), { code: 'permission_denied' });
  await assert.rejects(f.bridge.publish('invite', done.article.revision), { code: 'revision_conflict' });
  assert.equal((await f.bridge.status()).article_run.editor_url, remote.editor_url); assert.equal(uploads, 1);
});
test('MCP exposes orchestration instructions and the new lifecycle tools with foreground completion', async t => {
  const f = await runFixture(t); const server = createServer(f.bridge);
  const client = new Client({ name: 'workflow-test', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair(); await Promise.all([client.connect(ct), server.connect(st)]);
  t.after(() => client.close());
  assert.match(client.getInstructions(), /background/);
  const prepared = (await client.callTool({ name: 'supportpages_prepare_article', arguments: input })).structuredContent.result;
  await client.callTool({ name: 'supportpages_update_run', arguments: { run_id: prepared.run_id, event: 'started', execution_mode: 'foreground' } });
  await f.output();
  const result = await client.callTool({ name: 'supportpages_complete_article', arguments: { run_id: prepared.run_id, completed: true } });
  assert.equal(result.structuredContent.result.status, 'ready_for_review');
  const invalid = await client.callTool({ name: 'supportpages_update_run', arguments: { run_id: prepared.run_id, event: 'published' } });
  assert.equal(invalid.isError, true);
});

test('durable run record releases a stale active pointer after finalization', async t => {
  const f = await runFixture(t); const run = await f.bridge.prepare(input);
  const prepared = await f.bridge.runs.read(run.run_id);
  await f.output(); await f.bridge.finalize({ artifact_dir: run.artifact_dir, run_id: run.run_id, completed: true });
  // Simulate interruption between saving the canonical record and its active pointer.
  await f.ws.writeJson(`${f.bridge.stateRoot}/active-run.json`, prepared);
  assert.equal((await f.bridge.prepare({ ...input, title: 'Another' })).status, 'prepared');
  assert.equal((await f.bridge.complete({ run_id: run.run_id, completed: true })).status, 'ready_for_review');
  assert.equal((await f.bridge.status()).article_run.phase, 'prepared');
  assert.equal((await f.bridge.status(run.run_id)).article_run.phase, 'ready_for_review');
});


test('successful article delivery includes one fresh connection invitation and retries return it again', async t => {
  const repository_connection = { state: 'not_connected', connect_url: 'https://app.supportpages.io/projects/example/repository_connection?source=completion',
    capabilities: { sections: false, suggestions: false, code_analysis: false, maintenance: false } };
  const f = await runFixture(t, async () => Response.json({ import_id: '7', article: { ...remote, repository_connection } }));
  const request = f.bridge.api.request.bind(f.bridge.api);
  f.bridge.api.request = (method, route, ...args) => route.endsWith('/context') ? Promise.resolve({ ...context, repository_connection }) : request(method, route, ...args);
  const prepared = await f.bridge.prepare(input);
  await f.output();
  const done = await f.bridge.complete({ run_id: prepared.run_id, completed: true });
  assert.deepEqual(done.repository_connection, repository_connection);
  assert.equal(done.open_when_ready, false);
  assert.match(done.instructions.join(' '), /Never open the repository connection page automatically/);
  assert.equal(done.repository_invitation.id, 'agent_allowance');
  const replay = await f.bridge.complete({ run_id: prepared.run_id, completed: true });
  assert.deepEqual(replay.repository_invitation, done.repository_invitation, 'a replay returns the same invitation');
  assert.equal(replay.editor_url, done.editor_url);
});

test('legacy local-plan tool returns detection without exposing saved proposals', async t => {
  const f = await runFixture(t);
  const plan = await f.bridge.setup.plan('1');
  plan.recommendations = [{ id: 'old', title: 'Old idea', description: 'Old', type: 'how-to', section_id: null, section_slug: null, status: 'pending', previous_titles: [], justification: '' }];
  await f.bridge.setup.savePlan(plan);
  const value = await f.bridge.localPlan();
  assert.equal(value.analysis.status, 'ready');
  assert.equal(value.plan, undefined);
  assert.equal((await f.bridge.setup.plan('1')).recommendations.length, 1);
});

test('hosting limit failures preserve a completed bundle and recover by uploading, without regenerating', async t => {
  const uploads = [];
  const f = await runFixture(t, (_url, options) => {
    uploads.push({ key: options.headers['Idempotency-Key'], body: options.body.get('article') });
    return uploads.length === 1
      ? Response.json({ error: { code: 'plan_limit', message: 'Article hosting limit reached.' } }, { status: 403 })
      : Response.json({ import_id: '7', article: remote });
  });
  const run = await f.bridge.prepare(input);
  await f.output();
  await assert.rejects(f.bridge.complete({ run_id: run.run_id, completed: true }), error => {
    assert.equal(error.code, 'plan_limit');
    assert.equal(error.details.phase, 'upload_failed');
    assert.equal(error.details.generation_completed_locally, true);
    assert.equal(error.details.remote_state, 'unconfirmed');
    assert.match(error.details.instructions, /Free up article capacity/);
    return true;
  });
  const status = (await f.bridge.status()).article_run;
  assert.equal(status.phase, 'upload_failed');
  assert.equal((await f.bridge.runs.read(run.run_id)).status, 'finalized');
  assert.match(status.recovery, /Do not regenerate/);
  await f.output({ ...article, title: 'Changed after the failed upload' });
  assert.equal((await f.bridge.complete({ run_id: run.run_id, completed: true })).status, 'ready_for_review');
  assert.equal(uploads[0].key, uploads[1].key);
  assert.equal(await uploads[0].body.text(), await uploads[1].body.text());
});

test('upload failure preserves a known preview link without reporting a remote generation failure', async t => {
  const f = await runFixture(t, () => Response.json({ error: { code: 'permission_denied' } }, { status: 403 }));
  const run = await f.bridge.prepare(input);
  const saved = await f.bridge.runs.read(run.run_id);
  await f.bridge.lock(() => f.bridge.runs.save({ ...saved, progress: { attempt: run.run_id, sequence: 1, article: remote } }));
  await f.output();
  await assert.rejects(f.bridge.complete({ run_id: run.run_id, completed: true }), error => {
    assert.equal(error.details.editor_url, remote.editor_url);
    assert.equal(error.details.remote_state, 'preview_previously_confirmed');
    return error.code === 'permission_denied';
  });
  assert.equal(f.calls.filter(call => call.url.endsWith('/event')).length, 0);
  const status = (await f.bridge.status()).article_run;
  assert.equal(status.preview.id, remote.id);
  assert.equal(status.editor_url, remote.editor_url);
});

test('older finalized journals labelled failed are reported as upload failures without rewriting them', async t => {
  const f = await runFixture(t);
  const run = await f.bridge.prepare(input); await f.output();
  await f.bridge.finalize({ artifact_dir: run.artifact_dir, run_id: run.run_id, completed: true });
  const saved = await f.bridge.runs.read(run.run_id);
  await f.bridge.lock(() => f.bridge.runs.save({ ...saved, phase: 'failed', error: { code: 'permission_denied', message: 'SupportPages.io returned HTTP 403.' } }));
  assert.equal((await f.bridge.runs.progress(run.run_id)).phase, 'upload_failed');
  assert.equal((await f.bridge.runs.read(run.run_id)).phase, 'failed');
});
