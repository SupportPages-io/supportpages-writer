import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../dist/server.js';
import { analysedFixture, context, remote } from './helpers.mjs';

const input = { title: 'Invite', article_type: 'how-to' };
async function setup(t) {
  let preview, lost = false, offline = false, resumeFails = false, full = false;
  const starts = [];
  const f = await analysedFixture(t, async (url, request) => {
    if (offline) throw Error('Offline');
    if (url.endsWith('/context')) return Response.json({ ...context, progressive_articles: true,
      article_capacity: full ? { ...context.article_capacity, used: 10, can_create: false } : context.article_capacity });
    if (url.endsWith('/projects')) return Response.json({ projects: [{ id: '1', name: 'Example' }] });
    if (url.endsWith('/generation_runs')) {
      const body = JSON.parse(request.body);
      starts.push(body.run_id);
      preview ??= { run_id: body.run_id, attempt: body.attempt, state: 'running', sequence: 0, article: remote };
      if (lost) { lost = false; full = true; throw Error('Lost response after preview creation'); }
      return Response.json(preview);
    }
    if (url.endsWith('/event')) {
      const body = JSON.parse(request.body);
      if (body.event === 'resume') {
        if (resumeFails) return Response.json({ error: { code: 'run_closed', message: 'Draft kept for editing.' } }, { status: 409 });
        preview = { ...preview, state: 'running', attempt: body.next_attempt };
      } else if (body.event !== 'heartbeat') preview = { ...preview, state: body.event };
      return Response.json(preview);
    }
    throw Error(`Unexpected ${url}`);
  });
  await f.bridge.bind('1');
  const server = createServer(f.bridge), client = new Client({ name: 'article-links', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);
  t.after(() => client.close());
  const call = (name, args) => client.callTool({ name: `supportpages_${name}`, arguments: args });
  return { ...f, call, starts, loseResponse: () => { lost = true; }, goOffline: () => { offline = true; }, rejectResume: () => { resumeFails = true; } };
}
function hasVisibleLink(response, error = false) {
  const data = error ? response.structuredContent.error.details : response.structuredContent.result;
  assert.equal(data.editor_url, remote.editor_url);
  assert.ok(response.content.some(item => item.type === 'text' && item.text.startsWith(`View article: ${remote.editor_url}`)));
  if (data.link_instructions) assert.match(data.link_instructions, /Repeat it even if this article already existed/);
}

test('preparation returns a visible preview link before writer launch or any article content', async t => {
  const f = await setup(t);
  let opened = 0;
  f.bridge.relay.open = async () => { opened++; return true; };
  const prepared = await f.call('prepare_article', { ...input, open_when_ready: true });
  hasVisibleLink(prepared);
  const run = prepared.structuredContent.result;
  assert.equal(run.task_brief.editor_url, remote.editor_url);
  assert.equal((await f.bridge.runs.read(run.run_id)).phase, 'prepared');
  assert.equal(await f.ws.exists(run.artifact_dir), false);
  assert.equal(opened, 0);
  const started = await f.call('update_run', { run_id: run.run_id, event: 'started', execution_mode: 'foreground' });
  f.bridge.relay.stop();
  hasVisibleLink(started);
  assert.equal(f.starts.length, 1);
  assert.equal(opened, 0);
});

test('failure and successful retry both repeat the existing link without creating a second article', async t => {
  const f = await setup(t);
  const prepared = (await f.call('prepare_article', input)).structuredContent.result;
  const failed = await f.call('update_run', { run_id: prepared.run_id, event: 'failed', stopped: true });
  hasVisibleLink(failed);
  const retry = await f.call('retry_article', { run_id: prepared.run_id, stopped: true });
  hasVisibleLink(retry);
  assert.equal(retry.structuredContent.result.task_brief.editor_url, remote.editor_url);
  assert.equal(f.starts.length, 1);
});

test('host updates return compact text and structured data while status retains full diagnostics', async t => {
  for (const mode of ['foreground', 'background']) {
    const f = await setup(t);
    const prepared = (await f.call('prepare_article', input)).structuredContent.result;
    const updated = await f.call('update_run', { run_id: prepared.run_id, event: 'started', execution_mode: mode, host_task_id: 'writer-task' });
    f.bridge.relay.stop();
    assert.deepEqual(updated.structuredContent.result, {
      run_id: prepared.run_id, phase: 'writing', execution_mode: mode,
      editor_url: remote.editor_url, message: `Writer started in ${mode}.`,
    });
    assert.deepEqual(updated.content, [
      { type: 'text', text: `Writer started in ${mode}.` },
      { type: 'text', text: `View article: ${remote.editor_url}` },
    ]);
    const status = (await f.call('status', { run_id: prepared.run_id })).structuredContent.result.article_run;
    assert.equal(status.host_task_id, 'writer-task');
    assert.equal(status.artifact_dir, prepared.artifact_dir);
    assert.equal(status.execution_mode, mode);
    assert.equal(status.session_current, true);
    assert.ok(status.started_at);
    assert.ok(status.preview);
  }
});

test('compact acknowledgements retain synchronization problems and terminal events', async t => {
  for (const event of ['failed', 'interrupted', 'cancelled']) {
    const f = await setup(t);
    const prepared = (await f.call('prepare_article', input)).structuredContent.result;
    f.goOffline();
    const updated = await f.call('update_run', { run_id: prepared.run_id, event, stopped: true });
    const result = updated.structuredContent.result;
    assert.equal(result.phase, event);
    assert.ok(result.synchronization_error);
    assert.ok(updated.content[0].text.includes(result.synchronization_error));
    hasVisibleLink(updated);
    assert.equal((await f.bridge.runs.read(prepared.run_id)).status, event);
  }
});

test('startup without a preview link is explicit and rejected updates keep their errors', async t => {
  const f = await setup(t);
  const prepared = (await f.call('prepare_article', input)).structuredContent.result;
  const run = await f.bridge.runs.read(prepared.run_id);
  await f.bridge.runs.save({ ...run, progress: undefined });
  const updated = await f.call('update_run', { run_id: prepared.run_id, event: 'started', execution_mode: 'background' });
  assert.equal(updated.structuredContent.result.editor_url, null);
  assert.match(updated.content[0].text, /No confirmed article link/);
  assert.equal(updated.content.length, 1);
  const rejected = await f.call('update_run', { run_id: prepared.run_id, event: 'failed' });
  assert.equal(rejected.isError, true);
  assert.equal(rejected.structuredContent.error.code, 'writer_not_stopped');
  assert.match(rejected.content[0].text, /Stop the host task/);
});

test('a rejected retry still carries the saved editor link in its error and visible text', async t => {
  const f = await setup(t);
  const prepared = (await f.call('prepare_article', input)).structuredContent.result;
  await f.call('update_run', { run_id: prepared.run_id, event: 'failed', stopped: true });
  f.rejectResume();
  const retry = await f.call('retry_article', { run_id: prepared.run_id, stopped: true });
  assert.equal(retry.isError, true);
  assert.equal(retry.structuredContent.error.code, 'run_closed');
  hasVisibleLink(retry, true);
  assert.equal(f.starts.length, 1);
});

test('existing output from a cancelled run returns that article link when preparation is blocked', async t => {
  const f = await setup(t);
  const prepared = (await f.call('prepare_article', input)).structuredContent.result;
  await f.output();
  hasVisibleLink(await f.call('cancel_run', { run_id: prepared.run_id, stopped: true }));
  const duplicate = await f.call('prepare_article', input);
  assert.equal(duplicate.isError, true);
  assert.equal(duplicate.structuredContent.error.code, 'output_exists');
  assert.equal(duplicate.structuredContent.error.details.run_id, prepared.run_id);
  hasVisibleLink(duplicate, true);
  assert.equal(f.starts.length, 1);
});

test('offline retries and status retain the previously confirmed link', async t => {
  const f = await setup(t);
  const prepared = (await f.call('prepare_article', input)).structuredContent.result;
  f.goOffline();
  const retry = await f.call('retry_article', { run_id: prepared.run_id, stopped: true });
  assert.equal(retry.isError, true);
  hasVisibleLink(retry, true);
  const status = await f.call('status', { run_id: prepared.run_id });
  assert.equal(status.structuredContent.result.status, 'connection_error');
  assert.ok(status.content.some(item => item.text.startsWith(`View article: ${remote.editor_url}`)));
});

test('a lost preview response recovers the same link even when that preview filled the hosting limit', async t => {
  const f = await setup(t);
  f.loseResponse();
  const prepared = await f.call('prepare_article', input);
  assert.equal(prepared.isError, true);
  const details = prepared.structuredContent.error.details;
  assert.ok(details.run_id);
  assert.equal(details.editor_url, null);
  assert.match(details.link_message, /No confirmed article link/);
  assert.ok(!prepared.content.some(item => item.text.startsWith('View article:')));
  const retry = await f.call('retry_article', { run_id: details.run_id, stopped: true });
  assert.ok(!retry.isError);
  hasVisibleLink(retry);
  assert.deepEqual(f.starts, [details.run_id, details.run_id]);
});

test('journal lookup never attaches an article from a different project', async t => {
  const f = await setup(t);
  const prepared = (await f.call('prepare_article', input)).structuredContent.result;
  await f.ws.writeJson(`${f.bridge.stateRoot}/binding.json`, { version: 1, api_origin: f.bridge.api.origin, project_id: '2' });
  assert.equal(await f.bridge.articleErrorContext({ run_id: prepared.run_id }), undefined);
  assert.equal(await f.bridge.articleErrorContext({ title: 'Invite' }), undefined);
});
