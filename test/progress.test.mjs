import test from 'node:test';
import assert from 'node:assert/strict';
import { analysedFixture, article, png, remote, context } from './helpers.mjs';
import { ProgressRelay } from '../dist/progress.js';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { requestWriterCompletion, finishWriter } from '../dist/writer-entry.js';
import { Runs } from '../dist/runs.js';

async function setup(t, { open = false, reportStarted = true, automatic = false, progressive = true } = {}) {
  const calls = [], milestones = [];
  let run, opened = 0, failNext = false, failImport = false;
  const f = await analysedFixture(t, async (url, request) => {
    calls.push(url);
    if (url.endsWith('/context')) return Response.json({ ...context, progressive_articles: progressive });
    if (url.endsWith('/generation_runs')) {
      const body = JSON.parse(request.body);
      run ??= { run_id: body.run_id, attempt: body.attempt, state: 'running', sequence: 0, article: remote };
      return Response.json(run);
    }
    if (url.endsWith('/milestones')) {
      const form = request.body;
      milestones.push({ sequence: Number(form.get('sequence')), text: await form.get('article').text(), images: [...form.keys()].filter(k => k.startsWith('images[')) });
      run = { ...run, sequence: Number(form.get('sequence')), article: { ...remote, revision: 'b'.repeat(64) } };
      if (failNext) { failNext = false; throw Error('Lost response'); }
      return Response.json(run);
    }
    if (url.endsWith('/event')) {
      const body = JSON.parse(request.body);
      if (body.event === 'resume') run = { ...run, attempt: body.next_attempt, state: 'running', sequence: 0 };
      else if (body.event !== 'heartbeat') run = { ...run, state: body.event };
      return Response.json(run);
    }
    if (url.endsWith('/article_imports')) {
      if (failImport) throw Error('Delivery unavailable');
      if (run) {
        assert.equal(request.body.get('article_id'), remote.id);
        assert.equal(request.body.get('generation_attempt'), run.attempt);
        assert.equal(request.body.get('expected_revision'), run.article.revision);
        run = { ...run, state: 'complete' };
      } else {
        assert.equal(request.body.get('article_id'), null);
        assert.equal(request.body.get('generation_attempt'), null);
      }
      return Response.json({ import_id: '6', article: remote });
    }
    throw Error(`Unexpected ${url}`);
  });
  await f.bridge.bind('1');
  const prepared = await f.bridge.prepare({ title: 'Invite', article_type: 'how-to', open_when_ready: open });
  if (reportStarted) await f.bridge.updateRun({ run_id: prepared.run_id, event: 'started', execution_mode: 'background', host_task_id: 'writer' });
  if (!automatic) f.bridge.relay.stop();
  const relay = automatic ? f.bridge.relay : new ProgressRelay(f.bridge, async () => { opened++; return true; });
  t.after(() => { relay.stop(); f.bridge.close(); });
  return { ...f, relay, prepared, id: prepared.run_id, calls, milestones, opened: () => opened, loseNext: () => { failNext = true; }, failImport: value => failImport = value, remoteState: () => run.state };
}

test('a stopped relay cannot enqueue workspace operations after an in-flight observation', { timeout: 10000 }, async t => {
  const f = await setup(t);
  let observed, release;
  // The production relay intentionally uses an unref'ed observation timer.
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => { clearInterval(keepAlive); release?.(); });
  const observing = new Promise(resolve => { observed = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const read = Runs.prototype.read;
  let first = true;
  t.mock.method(Runs.prototype, 'read', async function(id) {
    const value = await read.call(this, id);
    if (id === f.id && first) { first = false; observed(); await held; }
    return value;
  });
  // Start a scheduled tick, then close the bridge while its initial read is
  // suspended outside the operation queue. The tick must never acquire a lock.
  let finished;
  const completed = new Promise(resolve => { finished = resolve; });
  const tick = f.relay.tick.bind(f.relay);
  t.mock.method(f.relay, 'tick', async (...args) => {
    try { return await tick(...args); } finally { finished(); }
  });
  f.relay.start(f.id);
  await observing;
  f.relay.stop();
  await f.bridge.close();
  const lock = t.mock.method(f.bridge, 'lock');
  release();
  await completed;
  assert.equal(lock.mock.callCount(), 0);
});

test('writer finish delivers and unlocks the preview without a parent completion call', async t => {
  const f = await setup(t, { automatic: true });
  await enter(f.prepared.task_brief);
  await f.output();
  const brief = f.prepared.task_brief;
  assert.deepEqual(brief.completion, brief.entrypoint.completion);
  const finished = await new Promise((resolve, reject) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('RTFM_')));
    const child = spawn(brief.completion.command, brief.completion.args, { cwd: brief.workspace,
      env: { ...env, SUPPORTPAGES_API_TOKEN: '', SUPPORTPAGES_API_TOKEN_FILE: '' } });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
    const timer = setTimeout(() => { child.kill(); reject(Error('Writer finish did not confirm delivery')); }, 15000);
    child.on('error', reject);
    child.on('exit', code => { clearTimeout(timer); code === 0 ? resolve(JSON.parse(stdout)) : reject(Error(stderr)); });
  });
  assert.equal(finished.status, 'ready_for_review');
  assert.equal(finished.editor_url, remote.editor_url);
  assert.equal(f.remoteState(), 'complete');
  assert.equal(f.calls.filter(url => url.endsWith('/article_imports')).length, 1);
  const saved = await f.bridge.runs.read(f.id);
  assert.ok(saved.writer_completed_at);
  assert.equal(saved.repository_reminder_checked, undefined, 'background delivery must not consume the parent response');
  const response = await f.bridge.complete({ run_id: f.id, completed: true });
  assert.match(response.instructions.join(' '), /Would you like me to publish it/);
  assert.equal(f.calls.filter(url => url.endsWith('/article_imports')).length, 1);
  assert.equal(f.calls.filter(url => url.endsWith('/publish')).length, 0);
});

test('a finished-looking preview never triggers final delivery without explicit writer success', async t => {
  const f = await setup(t);
  await f.output();
  await f.relay.tick(f.id);
  assert.equal(f.milestones.length, 1);
  await f.relay.tick(f.id);
  assert.equal(f.remoteState(), 'running');
  assert.equal(f.calls.filter(url => url.endsWith('/article_imports')).length, 0);
});

test('writer finish also delivers on servers without progressive previews', async t => {
  const f = await setup(t, { automatic: true, progressive: false });
  await f.output();
  const brief = f.prepared.task_brief;
  const result = await finishWriter(brief.entrypoint.args.slice(1), brief.environment, 10000);
  assert.equal(result.status, 'ready_for_review');
  assert.equal(f.calls.filter(url => url.endsWith('/generation_runs')).length, 0);
  assert.equal(f.calls.filter(url => url.endsWith('/article_imports')).length, 1);
});

test('finish without a live MCP reports pending delivery and restart resumes the saved request', async t => {
  const f = await setup(t);
  await f.output();
  const brief = f.prepared.task_brief;
  await assert.rejects(finishWriter(brief.entrypoint.args.slice(1), brief.environment, 0), { code: 'delivery_pending' });
  assert.equal((await f.bridge.runs.progress(f.id)).delivery_pending, true);
  await f.bridge.resumeWriterCompletion();
  await until(async () => (await f.bridge.runs.read(f.id)).phase === 'ready_for_review');
  assert.equal(f.remoteState(), 'complete');
  assert.equal((await finishWriter(brief.entrypoint.args.slice(1), brief.environment, 0)).status, 'ready_for_review');
});

test('automatic delivery failure is recoverable without rerunning or duplicating the writer', async t => {
  const f = await setup(t);
  await f.output();
  const brief = f.prepared.task_brief;
  await requestWriterCompletion(brief.entrypoint.args.slice(1), brief.environment);
  f.failImport(true);
  await assert.rejects(f.relay.tick(f.id), { code: 'network_error' });
  assert.equal((await f.bridge.runs.read(f.id)).phase, 'upload_failed');
  await assert.rejects(finishWriter(brief.entrypoint.args.slice(1), brief.environment, 0), error => {
    assert.equal(error.code, 'upload_failed');
    assert.match(error.message, /supportpages_complete_article/);
    return true;
  });
  assert.equal(f.remoteState(), 'running');
  f.failImport(false);
  await f.bridge.complete({ run_id: f.id, completed: true });
  assert.equal(f.remoteState(), 'complete');
  assert.equal(f.calls.filter(url => url.endsWith('/generation_runs')).length, 1);
});

async function enter(brief) {
  await new Promise((resolve, reject) => {
    const child = spawn(brief.entrypoint.command, brief.entrypoint.args, { cwd: brief.workspace,
      env: { ...process.env, ...brief.environment, SUPPORTPAGES_API_TOKEN: '', SUPPORTPAGES_API_TOKEN_FILE: '' }, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(Error(stderr)));
  });
}

async function until(check) {
  const deadline = Date.now() + 5000;
  while (!await check()) {
    assert.ok(Date.now() < deadline, 'automatic preview relay did not deliver');
    await delay(20);
  }
}

test('writer handshake starts heartbeats and live previews without a parent started call', async t => {
  const f = await setup(t, { reportStarted: false, automatic: true });
  await f.bridge.lock(async () => {
    const run = await f.bridge.runs.read(f.id);
    await f.bridge.runs.save({ ...run, progress: { ...run.progress, last_heartbeat: Date.now() - 120_000 } });
  });
  await f.ws.writeJson(`${f.prepared.artifact_dir}/article.json`, article);
  await f.relay.tick(f.id);
  assert.equal(f.milestones.length, 0, 'unstarted runs cannot upload even if output exists');
  assert.equal(f.calls.filter(url => url.endsWith('/event')).length, 0);
  assert.equal((await f.bridge.runs.read(f.id)).phase, 'prepared');

  await enter(f.prepared.task_brief);
  await until(async () => (await f.bridge.runs.read(f.id)).progress.sequence === 1);
  assert.equal(f.calls.filter(url => url.endsWith('/event')).length, 1, 'heartbeats begin after actual writer entry');
  assert.equal(f.milestones.length, 1);
  assert.deepEqual(f.milestones[0].images, []);
  const run = await f.bridge.runs.read(f.id);
  assert.equal(run.phase, 'writing');
  assert.equal(run.execution_mode, undefined, 'do not invent host execution metadata');
  assert.equal(run.progress.article.id, remote.id);

  await f.ws.write(`${f.prepared.artifact_dir}/block_invite.png`, png);
  await until(async () => (await f.bridge.runs.read(f.id)).progress.sequence === 2);
  assert.deepEqual(f.milestones[1].images, ['images[invite]']);
  await f.ws.writeJson(`${f.prepared.artifact_dir}/lint_report.json`, { all_passed: true });
  assert.equal((await f.bridge.complete({ run_id: f.id, completed: true })).article.id, remote.id);
  assert.equal(f.calls.filter(url => url.endsWith('/generation_runs')).length, 1);
});

test('retry watches the replacement writer and rejects the old startup handshake', async t => {
  const f = await setup(t, { reportStarted: false, automatic: true });
  await enter(f.prepared.task_brief);
  await f.bridge.updateRun({ run_id: f.id, event: 'failed', stopped: true });
  const retry = await f.bridge.retryArticle({ run_id: f.id, stopped: true });
  await assert.rejects(enter(f.prepared.task_brief), /entry check failed/);
  assert.equal((await f.bridge.runs.read(f.id)).phase, 'prepared');
  await f.ws.writeJson(`${f.prepared.artifact_dir}/article.json`, article);
  await enter(retry.task_brief);
  await until(async () => (await f.bridge.runs.read(f.id)).progress.sequence === 1);
  assert.equal(f.milestones.length, 1);
  assert.equal((await f.bridge.runs.read(f.id)).progress.article.id, remote.id);
});

test('relay posts prose first, then changed images, opens once and finalizes the same article', async t => {
  const f = await setup(t, { open: true });
  await f.ws.writeJson(`${f.prepared.artifact_dir}/article.json`, article);
  await f.relay.tick(f.id);
  assert.equal(f.milestones.length, 1);
  assert.deepEqual(f.milestones[0].images, []);
  assert.equal(f.opened(), 1);
  await f.ws.write(`${f.prepared.artifact_dir}/block_invite.png`, png);
  await f.relay.tick(f.id);
  assert.deepEqual(f.milestones[1].images, ['images[invite]']);
  await f.relay.tick(f.id);
  assert.equal(f.milestones.length, 2);
  assert.equal(f.opened(), 1);
  const replacement = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  assert.notDeepEqual(replacement, png);
  await f.ws.write(`${f.prepared.artifact_dir}/block_invite.png`, replacement);
  await f.relay.tick(f.id);
  assert.equal(f.milestones.length, 3, 'an improved image is uploaded without creating an article');
  assert.deepEqual(f.milestones[2].images, ['images[invite]']);
  assert.equal((await f.bridge.runs.progress(f.id)).open_when_ready, false);
  await f.ws.writeJson(`${f.prepared.artifact_dir}/lint_report.json`, { all_passed: true });
  const complete = await f.bridge.complete({ run_id: f.id, completed: true });
  assert.equal(complete.status, 'ready_for_review');
  assert.equal(complete.open_when_ready, false);
  assert.equal(complete.article.id, remote.id);
  await f.relay.tick(f.id);
  assert.equal(f.milestones.length, 3);
});

test('partial writes retain last good preview and do not open when disabled', async t => {
  const f = await setup(t);
  await f.ws.write(`${f.prepared.artifact_dir}/article.json`, '{');
  await f.relay.tick(f.id);
  assert.equal(f.milestones.length, 0);
  await f.ws.writeJson(`${f.prepared.artifact_dir}/article.json`, article);
  await f.ws.write(`${f.prepared.artifact_dir}/block_invite.png`, png.subarray(0, 30));
  await f.relay.tick(f.id);
  assert.equal(f.milestones.length, 1);
  assert.deepEqual(f.milestones[0].images, []);
  assert.equal(f.opened(), 0);
});

test('a lost response retries the persisted milestone before newer or temporarily invalid files', async t => {
  const f = await setup(t);
  await f.ws.writeJson(`${f.prepared.artifact_dir}/article.json`, article);
  f.loseNext();
  await assert.rejects(f.relay.tick(f.id), { code: 'network_error' });
  await f.ws.write(`${f.prepared.artifact_dir}/article.json`, '{');
  await f.relay.tick(f.id);
  assert.equal(f.milestones.length, 2);
  assert.deepEqual(f.milestones[0], f.milestones[1]);
  const run = await f.bridge.runs.read(f.id);
  assert.equal(run.progress.sequence, 1);
  assert.equal(run.progress.pending, undefined);
});

test('retry requires a stopped writer and keeps article identity while replacing the attempt', async t => {
  const f = await setup(t);
  const old = await f.bridge.runs.read(f.id);
  await assert.rejects(f.bridge.retryArticle({ run_id: f.id, stopped: false }), { code: 'writer_not_stopped' });
  await f.bridge.updateRun({ run_id: f.id, event: 'failed', stopped: true });
  const retry = await f.bridge.retryArticle({ run_id: f.id, stopped: true });
  const next = await f.bridge.runs.read(f.id);
  assert.notEqual(next.progress.attempt, old.progress.attempt);
  assert.equal(next.local_article_id, old.local_article_id);
  assert.equal(retry.editor_url, remote.editor_url);
  assert.equal(next.phase, 'prepared');
  assert.ok(retry.task_brief.instructions.some(instruction => instruction.includes('retain valid prose')));
  assert.equal(retry.task_brief.name, 'SupportPages.io');
  assert.match(retry.instructions, /subagent_type="supportpages-io"/);
});

test('preview status returns the early link without calling it a completed article', async t => {
  const f = await setup(t);
  const status = await f.bridge.runs.progress(f.id);
  assert.equal(status.editor_url, remote.editor_url);
  assert.equal(status.phase, 'writing');
  assert.equal(status.article, undefined);
  assert.equal(status.preview.id, remote.id);
});
