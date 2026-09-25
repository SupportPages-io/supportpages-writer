import test from 'node:test';
import assert from 'node:assert/strict';
import { analysedFixture as fixture, context } from './helpers.mjs';
import { ApiClient } from '../dist/api.js';
import { preferences, defaultPreferences } from '../dist/settings.js';
import { executionSettings } from '../scripts/lib/agent-settings.mjs';
import { backgroundParentInstruction, codexWriterLaunchInstruction, writerPermissionInstruction } from '../dist/writer-agent.js';

test('older servers use defaults only on 404; invalid settings and auth/network failures stay visible', async () => {
  for (const [status, code] of [[404, null], [401, 'invalid_credentials'], [403, 'permission_denied'], [500, 'remote_error']]) {
    const api = new ApiClient('https://app.supportpages.io', 'secret', async () => new Response('', {status}));
    if (code) await assert.rejects(preferences(api), {code});
    else assert.deepEqual(await preferences(api), defaultPreferences);
  }
  const api = new ApiClient('https://app.supportpages.io', 'secret', async () => Response.json({preferences:{open_when_ready:'true'}}));
  await assert.rejects(preferences(api), {code:'invalid_response'});
  await assert.rejects(preferences(new ApiClient('https://app.supportpages.io', 'secret', async () => {throw Error('offline');})), {code:'network_error'});
});

test('explicit requests override personal preferences which are snapshotted per run, without changing project context', async t => {
  const f = await fixture(t);
  let saved = {prefer_background:false,open_when_ready:true};
  f.bridge.api = new ApiClient('https://app.supportpages.io', 'secret', async url =>
    Response.json(url.endsWith('/mcp/settings') ? {preferences:saved} : {...context,product_context:{industry:'saas',project_type:['web']}}));
  await f.bridge.bind('1');
  const first = await f.bridge.prepare({title:'First',article_type:'how-to'});
  assert.equal(first.prefer_background, false);
  assert.equal(first.open_when_ready, true);
  saved = {prefer_background:true,open_when_ready:false};
  const record = await f.ws.json(`${f.bridge.stateRoot}/runs/${first.run_id}/run.json`);
  assert.equal(record.open_when_ready, true);
  assert.deepEqual((await f.ws.json(`${f.bridge.stateRoot}/runs/${first.run_id}/context.json`)).product_context,{industry:'saas',project_type:['web']});
  await f.bridge.cancel(first.run_id);
  const second = await f.bridge.prepare({title:'Second',article_type:'how-to',prefer_background:false,open_when_ready:true});
  assert.equal(second.prefer_background, false);
  assert.equal(second.open_when_ready, true);
  await f.bridge.cancel(second.run_id);
  const third = await f.bridge.prepare({title:'Third',article_type:'how-to'});
  assert.equal(third.prefer_background, true);
  assert.equal(third.open_when_ready, false);
});

test('a settings failure never reserves an article run', async t => {
  const f = await fixture(t); await f.bridge.bind('1');
  f.bridge.api = new ApiClient('https://app.supportpages.io', 'secret', async url =>
    url.endsWith('/mcp/settings') ? new Response('',{status:401}) : Response.json(context));
  await assert.rejects(f.bridge.prepare({title:'First',article_type:'how-to'}), {code:'invalid_credentials'});
  assert.equal(await f.ws.exists(`${f.bridge.stateRoot}/active-run.json`), false);
});

test('writer handoff uses the same model as CLI configuration, including custom models and inheritance', async t => {
  const f = await fixture(t); await f.bridge.bind('1');
  const file = `${f.bridge.stateRoot}/setup/settings.json`;
  for (const [index, model] of [undefined, 'opus', 'haiku', 'claude-custom-model', null].entries()) {
    await f.ws.writeJson(file, { agent: 'codex', models: { claude: { ...(model === undefined ? {} : { model }) }, codex: { model: 'codex-custom' } } });
    const prepared = await f.bridge.prepare({ title: `Model ${index}`, article_type: 'how-to' });
    assert.equal(prepared.task_brief.claude_model, model === undefined ? 'sonnet' : model);
    assert.equal(prepared.task_brief.claude_model, (await executionSettings(f.bridge, 'claude')).model);
    assert.match(prepared.instructions.join(' '), /model parameter to task_brief.claude_model/);
    assert.match(prepared.instructions.join(' '), /when null, omit the model parameter/);
    assert.match(prepared.instructions.join(' '), /only to Claude Code, not Codex/);
    await f.bridge.cancel(prepared.run_id);
  }
});

test('retry reads the latest configured writer model without regenerating a new run', async t => {
  const f = await fixture(t); await f.bridge.bind('1');
  const prepared = await f.bridge.prepare({ title: 'Retry model', article_type: 'how-to' });
  assert.equal(prepared.task_brief.claude_model, 'sonnet');
  await f.ws.writeJson(`${f.bridge.stateRoot}/setup/settings.json`, { models: { claude: { model: 'opus' } } });
  const retry = await f.bridge.retryArticle({ run_id: prepared.run_id, stopped: true });
  assert.equal(retry.run_id, prepared.run_id);
  assert.equal(retry.task_brief.claude_model, 'opus');
  assert.match(retry.instructions, /model parameter to task_brief.claude_model/);
});

test('invalid writer configuration fails before creating a run or changing a retry', async t => {
  const f = await fixture(t); await f.bridge.bind('1');
  const file = `${f.bridge.stateRoot}/setup/settings.json`;
  await f.ws.writeJson(file, { models: { claude: { model: '--bad-model' } } });
  await assert.rejects(f.bridge.prepare({ title: 'Invalid model', article_type: 'how-to' }), { code: 'invalid_configuration' });
  assert.equal(await f.ws.exists(`${f.bridge.stateRoot}/active-run.json`), false);
  await f.ws.writeJson(file, {});
  const prepared = await f.bridge.prepare({ title: 'Valid model', article_type: 'how-to' });
  const before = await f.bridge.runs.read(prepared.run_id);
  await f.ws.writeJson(file, { models: [] });
  await assert.rejects(f.bridge.retryArticle({ run_id: prepared.run_id, stopped: true }), { code: 'invalid_configuration' });
  assert.deepEqual(await f.bridge.runs.read(prepared.run_id), before);
});

test('Codex handoffs and retries use Codex model and effort settings independently of Claude', async t => {
  const f = await fixture(t); await f.bridge.bind('1');
  const prepared = await f.bridge.prepare({ title: 'Codex model', article_type: 'how-to' });
  assert.equal(prepared.task_brief.codex_model, null);
  assert.equal(prepared.task_brief.codex_reasoning_effort, null);
  assert.match(prepared.instructions.join(' '), /registered supportpages-io custom agent/);
  assert.match(prepared.task_brief.writer_instructions, /Do not edit application source, call SupportPages.io MCP tools/);
  assert.ok(prepared.instructions.join(' ').includes(codexWriterLaunchInstruction));
  assert.ok(prepared.instructions.includes(backgroundParentInstruction));
  assert.match(prepared.instructions.join(' '), /Keep the main turn active/);
  assert.doesNotMatch(prepared.instructions.join(' '), /end the main turn and return control without waiting/);
  assert.ok(prepared.task_brief.reporting_instructions.includes(writerPermissionInstruction));
  await f.ws.writeJson(`${f.bridge.stateRoot}/setup/settings.json`, {
    agent: 'codex', models: { codex: { model: 'codex-chosen-model', effort: 'high' }, claude: { model: 'opus', effort: 'low' } },
  });
  const retry = await f.bridge.retryArticle({ run_id: prepared.run_id, stopped: true });
  assert.ok(retry.instructions.includes(codexWriterLaunchInstruction));
  assert.ok(retry.instructions.includes(backgroundParentInstruction));
  assert.ok(retry.task_brief.reporting_instructions.includes(writerPermissionInstruction));
  assert.equal(retry.task_brief.codex_model, 'codex-chosen-model');
  assert.equal(retry.task_brief.codex_reasoning_effort, 'high');
  assert.equal(retry.task_brief.claude_model, 'opus');
  assert.equal(retry.task_brief.writer_instructions, prepared.task_brief.writer_instructions);
  await f.bridge.cancel(prepared.run_id);
  const next = await f.bridge.prepare({ title: 'Next Codex article', article_type: 'how-to' });
  assert.equal(next.task_brief.codex_model, 'codex-chosen-model');
  assert.equal(next.task_brief.codex_reasoning_effort, 'high');
});
