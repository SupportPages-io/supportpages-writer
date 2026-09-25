import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { RepositoryReminders, repositoryBenefits, articleDuration } from '../dist/repository-benefits.js';
import { analysedFixture as fixture, context, remote } from './helpers.mjs';
import { Bridge } from '../dist/bridge.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../dist/server.js';

const origin = 'https://app.supportpages.io';
const connection = { state: 'not_connected', connect_url: `${origin}/projects/example/repository_connection`,
  capabilities: { sections: false, suggestions: false, code_analysis: false, maintenance: false } };
const input = (articleId = randomUUID()) => ({ origin, projectId: '1', articleId, connection });

test('cadence rotates all 15 benefits without repeating eligible copy and avoids adjacent categories', async t => {
  const f = await fixture(t), reminders = new RepositoryReminders(path.join(f.root, 'config'));
  const shown = [];
  for (let count = 1; count <= 46; count++) {
    const value = input();
    const invitation = await reminders.complete({ ...value, firstWriterStartedAt: '2026-01-01T00:00:00Z', readyAt: '2026-01-01T00:05:00Z' });
    assert.equal(Boolean(invitation), (count - 1) % 3 === 0);
    assert.equal(await reminders.complete(value), undefined, 'the same article never counts twice');
    if (invitation) shown.push(invitation);
  }
  assert.equal(shown[0].id, 'agent_allowance');
  assert.equal(new Set(shown.slice(0, 15).map(item => item.id)).size, 15);
  assert.ok(shown.slice(0, 15).some(item => item.id === shown[15].id));
  for (let i = 1; i < shown.length; i++) {
    const category = item => repositoryBenefits.find(benefit => benefit.id === item.id).category;
    assert.notEqual(category(shown[i]), category(shown[i - 1]));
  }
});

test('unknown, connected, broken and disabled states count delivery but suppress reminders', async t => {
  const f = await fixture(t), dir = path.join(f.root, 'config');
  for (const state of [undefined, 'connected', 'suspended', 'disconnected']) {
    const reminders = new RepositoryReminders(path.join(dir, String(state)));
    assert.equal(await reminders.complete({ ...input(), connection: state ? { ...connection, state } : undefined }), undefined);
    assert.equal(await reminders.complete(input()), undefined);
    assert.equal(await reminders.complete(input()), undefined);
    assert.equal((await reminders.complete(input())).id, 'agent_allowance');
  }
  const a = new RepositoryReminders(dir), b = new RepositoryReminders(dir);
  await a.preference(origin, '1', false);
  for (let i = 0; i < 6; i++) assert.equal(await b.complete(input()), undefined);
  assert.equal((await b.preference(origin, '1')).enabled, false);
  assert.equal((await b.complete({ ...input(), projectId: '2' })).id, 'agent_allowance');
  assert.equal((await b.complete({ ...input(), origin: 'https://app.lvh.me:3443' })).id, 'agent_allowance');
  await b.preference(origin, '1', true);
  assert.equal((await a.complete(input())).id, 'agent_allowance');
});

test('timing is optional, rounded down and represents elapsed turnaround', async t => {
  assert.equal(articleDuration(), undefined);
  assert.equal(articleDuration('invalid', 'invalid'), undefined);
  const start = '2026-01-01T00:00:00Z';
  assert.equal(articleDuration(start, '2025-12-31T23:59:00Z'), undefined);
  assert.equal(articleDuration(start, '2026-01-01T00:04:59Z'), undefined);
  assert.equal(articleDuration(start, '2026-01-01T00:05:59Z'), '5 minutes');
  assert.equal(articleDuration(start, '2026-01-01T01:00:00Z'), '1 hour');
  assert.equal(articleDuration(start, '2026-01-01T02:01:10Z'), '2 hours 1 minute');
  const f = await fixture(t), reminders = new RepositoryReminders(path.join(f.root, 'config'));
  const ids = new Set();
  for (let i = 0; i < 42; i++) {
    const invitation = await reminders.complete(input());
    if (invitation) ids.add(invitation.id);
  }
  assert.equal(ids.size, 14);
  assert.equal(ids.has('elapsed_generation'), false);
  // Newly eligible copy is used before beginning the next cycle.
  const timed = await reminders.complete({ ...input(), firstWriterStartedAt: start, readyAt: '2026-01-01T00:06:00Z' });
  assert.equal(timed.id, 'elapsed_generation');
  assert.match(timed.message, /ready in 6 minutes/);
});

test('independent processes serialize shared completion counts and deduplicate concurrent replays', async t => {
  const f = await fixture(t), dir = path.join(f.root, 'config'), sameArticle = randomUUID();
  const moduleUrl = new URL('../dist/repository-benefits.js', import.meta.url).href;
  const call = value => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `import {RepositoryReminders} from ${JSON.stringify(moduleUrl)};
      const result = await new RepositoryReminders(process.argv[1]).complete(JSON.parse(process.argv[2]));
      process.stdout.write(JSON.stringify(result ?? null));`, dir, JSON.stringify(value)]);
    let stdout = '', stderr = '';
    child.stdout.on('data', value => stdout += value); child.stderr.on('data', value => stderr += value);
    child.on('error', reject); child.on('close', code => code === 0 ? resolve(JSON.parse(stdout)) : reject(Error(stderr)));
  });
  const replays = await Promise.all(Array.from({ length: 4 }, () => call(input(sameArticle))));
  assert.equal(replays.filter(Boolean).length, 1);
  const separate = await Promise.all(Array.from({ length: 6 }, () => call(input())));
  assert.equal(separate.filter(Boolean).length, 2); // articles 4 and 7
});

async function deliveryFixture(t) {
  let live = connection, failLookup = false, failUpload = false;
  const f = await fixture(t, async url => {
    if (url.endsWith('/context')) {
      if (failLookup) throw Error('offline');
      return Response.json({ ...context, repository_connection: live });
    }
    if (url.endsWith('/article_imports') && failUpload) throw Error('upload failed');
    return Response.json({ import_id: '7', article: { ...remote, repository_connection: connection } });
  });
  await f.bridge.bind('1');
  const prepared = await f.bridge.prepare({ title: 'Invite', article_type: 'how-to' });
  await f.output();
  return { ...f, prepared, live: value => live = value, failLookup: () => failLookup = true, failUpload: value => failUpload = value };
}

test('fresh state overrides uploaded snapshot and lookup failures cannot break delivery', async t => {
  for (const state of ['connected', 'suspended', 'disconnected', undefined, 'offline']) {
    const f = await deliveryFixture(t);
    if (state === 'offline') {
      // Avoid failing mandatory pre-upload context checks: fail only the final lookup.
      const request = f.bridge.api.request.bind(f.bridge.api);
      f.bridge.api.request = (...args) => args[4] === 3000 ? Promise.reject(Error('offline')) : request(...args);
    } else f.live(state ? { ...connection, state } : undefined);
    const result = await f.bridge.complete({ run_id: f.prepared.run_id, completed: true });
    assert.equal(result.editor_url, remote.editor_url);
    assert.equal(result.repository_invitation, undefined);
    assert.match(result.instructions.join(' '), /Do not add a repository connection invitation/);
  }
});

test('a failed connection lookup does not use up the reminder slot', async t => {
  const f = await deliveryFixture(t), id = f.prepared.run_id;
  const request = f.bridge.api.request.bind(f.bridge.api);
  f.bridge.api.request = (...args) => args[4] === 3000 ? Promise.reject(Error('offline')) : request(...args);
  const offline = await f.bridge.complete({ run_id: id, completed: true });
  assert.equal(offline.repository_invitation, undefined);
  assert.notEqual((await f.bridge.runs.read(id)).repository_reminder_checked, true);
  // Back online, the same draft is counted as the help centre's first article.
  f.bridge.api.request = request;
  const online = await f.bridge.complete({ run_id: id, completed: true });
  assert.equal(online.repository_invitation.id, 'agent_allowance');
  assert.match(online.instructions[0], /^Show show_to_user verbatim as its own paragraph, right after the draft review link/);
});

test('writer retries and completion replay preserve immutable timestamps and saved selection', async t => {
  const f = await deliveryFixture(t), id = f.prepared.run_id;
  await f.bridge.updateRun({ run_id: id, event: 'started', execution_mode: 'background' });
  const first = (await f.bridge.runs.read(id)).first_writer_started_at;
  await f.bridge.updateRun({ run_id: id, event: 'interrupted', stopped: true });
  await f.bridge.retryArticle({ run_id: id, stopped: true });
  await f.bridge.updateRun({ run_id: id, event: 'started', execution_mode: 'foreground' });
  assert.equal((await f.bridge.runs.read(id)).first_writer_started_at, first);
  f.failUpload(true);
  await assert.rejects(f.bridge.complete({ run_id: id, completed: true }), { code: 'network_error' });
  assert.equal((await f.bridge.runs.read(id)).ready_for_review_at, undefined);
  f.failUpload(false);
  const result = await f.bridge.complete({ run_id: id, completed: true });
  assert.equal(result.repository_invitation.id, 'agent_allowance');
  const saved = await f.bridge.runs.read(id);
  assert.ok(saved.ready_for_review_at);
  assert.deepEqual(saved.repository_invitation, result.repository_invitation);
  assert.deepEqual((await f.bridge.complete({ run_id: id, completed: true })).repository_invitation, result.repository_invitation);
  await f.bridge.runs.save({ ...saved, phase: 'published', first_writer_started_at: '2099-01-01T00:00:00Z', ready_for_review_at: '2099-01-01T01:00:00Z' });
  const replay = await f.bridge.runs.read(id);
  assert.equal(replay.first_writer_started_at, first);
  assert.equal(replay.ready_for_review_at, saved.ready_for_review_at);
});

test('local reminder journal errors preserve a delivered draft', async t => {
  const f = await deliveryFixture(t);
  await f.ws.write('bad-config', 'not a directory');
  const bridge = new Bridge(f.ws, f.bridge.api, f.bridge.skillsDir, undefined, undefined, path.join(f.root, 'bad-config'));
  const done = await bridge.complete({ run_id: f.prepared.run_id, completed: true });
  assert.equal(done.editor_url, remote.editor_url);
  assert.equal(done.repository_invitation, undefined);
  assert.equal((await bridge.runs.read(f.prepared.run_id)).phase, 'ready_for_review');
});

test('completion cadence and preferences follow the help centre across different workspaces', async t => {
  const owner = await fixture(t), configDir = path.join(owner.root, 'shared-config');
  let previous;
  for (let count = 1; count <= 4; count++) {
    const f = await deliveryFixture(t);
    const bridge = new Bridge(f.ws, f.bridge.api, f.bridge.skillsDir, undefined, undefined, configDir);
    const result = await bridge.complete({ run_id: f.prepared.run_id, completed: true });
    assert.equal(Boolean(result.repository_invitation), count === 1 || count === 4);
    if (previous) {
      await previous.repositoryReminders(false);
      assert.equal((await bridge.repositoryReminders()).enabled, false);
      await bridge.repositoryReminders(true);
    }
    previous = bridge;
  }
});

test('Claude and Codex receive the same optional invitation and can persist dismissal through MCP', async t => {
  for (const name of ['claude-code', 'codex']) {
    const f = await deliveryFixture(t);
    const client = new Client({ name, version: '1.0.0' });
    const server = createServer(f.bridge);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a); await client.connect(b); t.after(() => client.close());
    const args = { run_id: f.prepared.run_id, completed: true };
    const result = await client.callTool({ name: 'supportpages_complete_article', arguments: args });
    assert.equal(result.structuredContent.result.repository_invitation.id, 'agent_allowance');
    assert.deepEqual(JSON.parse(result.content[0].text).result, result.structuredContent.result);
    assert.equal(result.structuredContent.result.editor_url, remote.editor_url);
    const replay = await client.callTool({ name: 'supportpages_complete_article', arguments: args });
    assert.deepEqual(replay.structuredContent.result.repository_invitation, result.structuredContent.result.repository_invitation);
    assert.equal(result.structuredContent.result.show_to_user,
      `${result.structuredContent.result.repository_invitation.message} [Connect repository](${result.structuredContent.result.repository_invitation.connect_url})`);
    for (const enabled of [false, true]) {
      const preference = await client.callTool({ name: 'supportpages_set_repository_reminders', arguments: { enabled } });
      assert.equal(preference.structuredContent.result.enabled, enabled);
      assert.equal((await f.bridge.repositoryReminders()).enabled, enabled);
    }
  }
});
