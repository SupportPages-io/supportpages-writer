import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { localFixture, fixture, seedAnalysis, article, png, remote, context } from './helpers.mjs';
import { ApiClient } from '../dist/api.js';
import { finishWriter, requestWriterCompletion } from '../dist/writer-entry.js';

async function writeOutput(f, prepared, value = article) {
  const dir = prepared.artifact_dir;
  await f.ws.writeJson(`${dir}/article.json`, value);
  await f.ws.write(`${dir}/block_invite.png`, png);
  await f.ws.writeJson(`${dir}/lint_report.json`, { all_passed: true, global_warnings: [] });
}

test('a local workspace reports local status and prepares articles with no credential or network', async t => {
  const f = await localFixture(t, { writing_style: 'minimal', preferences: { prefer_background: false, open_when_ready: false } });
  const status = await f.bridge.status();
  assert.equal(status.status, 'local'); assert.equal(status.generation_ready, true);
  assert.equal(status.export_dir, 'output/articles'); assert.equal(status.credentials_configured, false);
  assert.equal(await f.bridge.destination(), 'local');
  const prepared = await f.bridge.prepare({ title: 'Invite a teammate', article_type: 'how-to', description: 'From the members page.' });
  assert.equal(prepared.status, 'prepared'); assert.equal(prepared.local, true);
  assert.equal(prepared.artifact_dir, '.rtfm/supportpages/work/local/invite-a-teammate');
  assert.equal(prepared.saved_to, 'output/articles/invite-a-teammate');
  assert.equal(prepared.editor_url, null); assert.equal(prepared.prefer_background, false);
  assert.match(prepared.link_message, /will be saved to output\/articles\/invite-a-teammate/);
  assert.match(prepared.link_instructions, /saved Markdown path is the deliverable/);
  assert.ok(prepared.instructions.some(line => /never ask whether to publish/i.test(line)));
  assert.ok(!prepared.instructions.some(line => /Would you like me to publish/.test(line)));
  const run = await f.ws.json(`.rtfm/supportpages/runs/${prepared.run_id}/run.json`);
  assert.equal(run.project_id, undefined); assert.equal(run.api_origin, undefined); assert.equal(run.progress, undefined);
  const saved = await f.ws.json(path.relative(f.root, prepared.environment.RTFM_CONTEXT_FILE));
  assert.equal(saved.local, true); assert.equal(saved.project.id, undefined);
  assert.match(saved.writing_style, /^Voice: terse quick-reference/);
  assert.equal(saved.article_description, 'From the members page.');
  assert.equal(saved.project_overview, 'Helps people work together.');
  await assert.rejects(f.bridge.prepare({ title: 'Other', article_type: 'how-to', section_id: '2' }), { code: 'invalid_section' });
});

test('completing a local run finalizes, exports Markdown beside the screenshots and never uploads', async t => {
  const f = await localFixture(t);
  const prepared = await f.bridge.prepare({ title: 'Invite', article_type: 'how-to' });
  await writeOutput(f, prepared);
  const result = await f.bridge.complete({ run_id: prepared.run_id, completed: true });
  assert.equal(result.status, 'saved'); assert.equal(result.local, true);
  assert.equal(result.markdown_path, path.join(f.root, 'output/articles/invite/index.md'));
  assert.equal(result.image_count, 1); assert.equal(result.editor_url, null);
  assert.match(result.link_message, /^Saved to /); assert.match(result.preview_uri, /^file:/);
  assert.ok(result.instructions.some(line => /supportpages_publish/.test(line)));
  assert.ok(!result.instructions.some(line => /terminal|supportpages publish\b/.test(line)), 'the agent never points at the CLI');
  assert.ok(result.instructions.some(line => /ignored by git/.test(line)));
  assert.match(await readFile(result.markdown_path, 'utf8'), /^# Invite a teammate\n/);
  const run = await f.ws.json(`.rtfm/supportpages/runs/${prepared.run_id}/run.json`);
  assert.equal(run.phase, 'saved'); assert.equal(run.status, 'finalized'); assert.equal(run.export_path, result.markdown_path);
  const state = await f.ws.json('.rtfm/supportpages/articles/invite.json');
  assert.equal(state.project_id, undefined); assert.equal(state.remote, undefined);
  // Repeating completion (the relay and the parent both call it) returns the same saved result.
  const again = await f.bridge.complete({ run_id: prepared.run_id, completed: true }, { deliver: false });
  assert.equal(again.status, 'saved'); assert.equal(again.markdown_path, result.markdown_path);
  const progress = await f.bridge.runs.progress(prepared.run_id);
  assert.equal(progress.phase, 'saved'); assert.equal(progress.delivery_pending, false);
  assert.equal(progress.export_path, result.markdown_path); assert.match(progress.link_message, /^Saved to /);
  const listed = await f.bridge.listLocal();
  assert.equal(listed.status, 'local');
  assert.deepEqual(listed.articles.map(item => [item.slug, item.title, item.export_path]), [['invite', 'Invite a teammate', result.markdown_path]]);
  assert.equal((await f.bridge.status()).article_run.phase, 'saved');
});

test('a docs export folder receives the screenshots, and a failed export keeps the run retryable', async t => {
  const f = await localFixture(t, { export_dir: 'docs/help' });
  const prepared = await f.bridge.prepare({ title: 'Invite', article_type: 'how-to' });
  await writeOutput(f, prepared);
  const result = await f.bridge.complete({ run_id: prepared.run_id, completed: true });
  assert.equal(result.markdown_path, path.join(f.root, 'docs/help/invite/index.md'));
  assert.equal(await f.ws.exists('docs/help/invite/block_invite.png'), true);
  assert.ok(!result.instructions.some(line => /ignored by git/.test(line)));
  const failed = await localFixture(t);
  const second = await failed.bridge.prepare({ title: 'Broken', article_type: 'how-to' });
  await failed.ws.writeJson(`${second.artifact_dir}/article.json`, article);
  await failed.ws.write(`${second.artifact_dir}/block_invite.png`, png);
  await failed.ws.writeJson(`${second.artifact_dir}/lint_report.json`, { all_passed: false });
  await assert.rejects(failed.bridge.complete({ run_id: second.run_id, completed: true }), { code: 'quality_check_failed' });
  const run = await failed.ws.json(`.rtfm/supportpages/runs/${second.run_id}/run.json`);
  assert.equal(run.phase, 'failed'); assert.equal(run.error.code, 'quality_check_failed');
});

test('a stopped local writer can be retried without a help centre', async t => {
  const f = await localFixture(t);
  const prepared = await f.bridge.prepare({ title: 'Invite', article_type: 'how-to' });
  const retried = await f.bridge.retryArticle({ run_id: prepared.run_id, stopped: true });
  assert.equal(retried.run_id, prepared.run_id); assert.equal(retried.local, true); assert.equal(retried.editor_url, null);
  assert.notEqual(retried.task_brief.entrypoint.args.at(-1), prepared.task_brief.entrypoint.args.at(-1));
  assert.match(retried.instructions, /saved locally when complete/);
  const errorContext = await f.bridge.articleErrorContext({ run_id: prepared.run_id });
  assert.equal(errorContext.run_id, prepared.run_id);
  assert.deepEqual(await f.bridge.localPlan(), { analysis: await f.bridge.setup.analysis() });
});

test('publishing adopts local articles into the help centre and later runs are hosted', async t => {
  const f = await localFixture(t);
  const prepared = await f.bridge.prepare({ title: 'Invite', article_type: 'how-to' });
  await writeOutput(f, prepared);
  await f.bridge.complete({ run_id: prepared.run_id, completed: true });
  const calls = [];
  f.bridge.api = new ApiClient('https://app.supportpages.io', 'test-secret', async (url, init) => {
    calls.push(url);
    if (url.endsWith('/mcp/settings')) return Response.json({ preferences: { prefer_background: true, open_when_ready: false } });
    if (url.endsWith('/context')) return Response.json({ ...context, article_sync: true });
    if (url.endsWith('/article_imports')) return Response.json({ import_id: '7', article: remote });
    if (url.includes('/sync')) {
      const state = await f.ws.json('.rtfm/supportpages/articles/invite.json');
      const uploaded = state.remote ? [{ ...remote, local_article_id: state.local_article_id, title: 'Invite a teammate', section_id: null, deleted_at: null, accepted_bundle_hash: state.bundle_hash }] : [];
      return Response.json({ project_id: '1', through_id: '5', next_cursor: null, articles: uploaded });
    }
    return Response.json({ projects: [context.project] });
  });
  await f.bridge.bind('1');
  assert.equal(await f.bridge.destination(), 'hosted');
  assert.equal((await f.bridge.status()).status, 'ready');
  assert.deepEqual((await f.bridge.localArticles()).map(item => item.slug), ['invite']);
  await f.bridge.upload('invite');
  const state = await f.ws.json('.rtfm/supportpages/articles/invite.json');
  assert.equal(state.project_id, '1'); assert.equal(state.api_origin, 'https://app.supportpages.io'); assert.equal(state.remote.id, '5');
  const run = await f.ws.json(`.rtfm/supportpages/runs/${prepared.run_id}/run.json`);
  assert.equal(run.project_id, '1'); assert.equal(run.phase, 'ready_for_review');
  assert.deepEqual(await f.bridge.localArticles(), []);
  const listed = await f.bridge.listLocal();
  assert.equal(listed.status, 'ready');
  assert.equal(listed.articles.find(item => item.local_article_id === state.local_article_id)?.sync_status, 'synced');
  await assert.rejects(f.bridge.retryArticle({ run_id: prepared.run_id, stopped: true }), { code: 'invalid_run' });
});

test('a bound workspace ignores leftover local settings', async t => {
  const f = await fixture(t, async url => Response.json(url.endsWith('/projects') ? { projects: [context.project] } : context));
  await seedAnalysis(f.ws);
  await f.bridge.saveLocal({ version: 1, export_dir: 'docs' });
  await f.bridge.bind('1');
  assert.equal(await f.bridge.destination(), 'hosted');
  assert.equal((await f.bridge.status()).status, 'ready');
  const prepared = await f.bridge.prepare({ title: 'Hosted', article_type: 'how-to' });
  assert.equal(prepared.local, undefined);
  assert.equal((await f.ws.json(`.rtfm/supportpages/runs/${prepared.run_id}/run.json`)).project_id, '1');
});

const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('RTFM_') && key !== 'OUT'));
const invoke = (invocation, extra = []) => new Promise((resolve, reject) => {
  const child = spawn(invocation.command, [...invocation.args, ...extra], { env: cleanEnv(), cwd: '/' });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
  child.on('error', reject); child.on('close', status => resolve({ status, stdout, stderr }));
});

test('the writer entrypoint runs without a help centre and its finish command returns the saved path once the relay delivers', async t => {
  const f = await localFixture(t);
  const prepared = await f.bridge.prepare({ title: 'Invite', article_type: 'how-to' });
  const brief = prepared.task_brief;
  const entry = await invoke(brief.entrypoint);
  assert.equal(entry.status, 0, entry.stderr);
  assert.match(entry.stdout, /^SupportPages.io prepared run: /);
  assert.equal((await f.bridge.runs.read(prepared.run_id)).phase, 'writing');
  const wrapped = await invoke(brief.execution, ['/bin/sh', '-c', 'printf "%s" "$RTFM_OUTPUT_DIR"']);
  assert.equal(wrapped.status, 0, wrapped.stderr);
  assert.equal(wrapped.stdout, path.join(f.root, prepared.artifact_dir));
  // Finishing before the files exist is rejected, exactly as for hosted runs.
  const early = await invoke(brief.completion);
  assert.notEqual(early.status, 0); assert.match(early.stderr, /missing_artifact/);
  await writeOutput(f, prepared);
  const marked = await requestWriterCompletion(brief.entrypoint.args.slice(1));
  assert.ok(marked.writer_completed_at); assert.equal(marked.remote, undefined);
  // The relay in the MCP process notices the finished writer and saves the article; no network is involved.
  await f.bridge.relay.tick(prepared.run_id);
  const saved = await f.bridge.runs.read(prepared.run_id);
  assert.equal(saved.phase, 'saved'); assert.equal(saved.error, undefined);
  assert.equal(await f.ws.exists('output/articles/invite/index.md'), true);
  await f.bridge.relay.tick(prepared.run_id);
  assert.equal(f.bridge.relay.running, false);
  const finished = await finishWriter(brief.entrypoint.args.slice(1), {}, 2000);
  assert.equal(finished.status, 'saved'); assert.equal(finished.markdown_path, saved.export_path);
  assert.match(finished.instructions, /must not ask to publish/);
  const again = await invoke(brief.completion);
  assert.equal(again.status, 0, again.stderr); assert.equal(JSON.parse(again.stdout).status, 'saved');
  assert.equal((await f.bridge.status()).article_run.delivery_pending, false);
});

test('a finished local writer with no live MCP reports pending saving, and restart resumes it', async t => {
  const f = await localFixture(t);
  const prepared = await f.bridge.prepare({ title: 'Invite', article_type: 'how-to' });
  f.bridge.relay.stop();
  await invoke(prepared.task_brief.entrypoint);
  await writeOutput(f, prepared);
  await assert.rejects(finishWriter(prepared.task_brief.entrypoint.args.slice(1), {}, 300), { code: 'delivery_pending', message: /to save the article/ });
  const progress = await f.bridge.runs.progress(prepared.run_id);
  assert.equal(progress.delivery_pending, true); assert.match(progress.recovery, /has not been saved yet/);
  await f.bridge.resumeWriterCompletion();
  assert.equal(f.bridge.relay.running, true);
  await f.bridge.relay.tick(prepared.run_id);
  assert.equal((await f.bridge.runs.read(prepared.run_id)).phase, 'saved');
  await f.bridge.resumeWriterCompletion();
  assert.equal(f.bridge.relay.running, false);
});

test('a local run cannot be written once the folder is connected to a help centre', async t => {
  const f = await localFixture(t);
  const prepared = await f.bridge.prepare({ title: 'Invite', article_type: 'how-to' });
  await f.ws.writeJson('.rtfm/supportpages/binding.json', { version: 1, project_id: '1', api_origin: 'https://app.supportpages.io' });
  const entry = await invoke(prepared.task_brief.entrypoint);
  assert.notEqual(entry.status, 0); assert.match(entry.stderr, /destination_mismatch/);
});

test('a project map that reports an incomplete detection is not ready and names its app type', async t => {
  const f = await localFixture(t);
  const map = await f.ws.json('.rtfm/project_map.json');
  await f.ws.writeJson('.rtfm/project_map.json', { ...map, app_type: 'web', app_type_source: 'default', detection_status: 'incomplete',
    detection_block: 'Classifier defaults to web without ambiguity notes, but source has no web layouts. Explicit app_type=terminal is required by the skill to select the terminal branch.' });
  const status = await f.bridge.status();
  assert.equal(status.status, 'local');
  assert.equal(status.generation_ready, false);
  assert.equal(status.analysis.status, 'invalid');
  assert.match(status.instructions, /Explicit app_type=terminal is required/);
  assert.match(status.instructions, /supportpages analyse --app-type terminal/);
  await assert.rejects(f.bridge.prepare({ title: 'How to install', article_type: 'how-to' }), error => {
    assert.equal(error.code, 'analysis_required');
    assert.equal(error.details?.app_type, 'terminal');
    assert.equal(error.details?.rerun, 'supportpages analyse --app-type terminal');
    assert.match(error.message, /Explicit app_type=terminal is required/);
    return true;
  });
  // A map that finishes its detection still counts as ready.
  await f.ws.writeJson('.rtfm/project_map.json', { ...map, detection_status: 'complete', detection_block: null });
  assert.equal((await f.bridge.status()).generation_ready, true);
});
