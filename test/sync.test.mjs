import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, seedAnalysis, context, article, png, remote } from './helpers.mjs';
import { replaceConnection } from '../dist/replace-connection.js';
import { runCli } from '../scripts/lib/cli.mjs';
import { ProjectSync } from '../dist/sync.js';
import { rename, rm } from 'node:fs/promises';

async function setup(t) {
  const state = { project: { ...context.project }, articles: [], calls: [], offline: false, loseUpload: false };
  const f = await fixture(t, async (url, init) => {
    state.calls.push({ url, method: init.method });
    if (state.offline) throw Error('offline');
    const id = url.match(/projects\/(\d+)/)?.[1] ?? state.project.id;
    if (url.endsWith('/context')) return Response.json({ ...context, article_sync: true, project: { ...state.project, id }, writing_style: 'Friendly' });
    if (url.includes('/sync')) return Response.json({ project_id: id, through_id: '999', next_cursor: null, articles: state.articles });
    if (url.endsWith('/article_imports')) {
      const manifest = JSON.parse(init.body.get('manifest'));
      const existing = state.articles.find(item => item.local_article_id === manifest.local_article_id);
      const metadata = { ...remote, id: existing?.id ?? String(state.articles.length + 5), title: article.title, local_article_id: manifest.local_article_id,
        deleted_at: null, section_id: null, accepted_bundle_hash: manifest.bundle_hash };
      state.articles = [...state.articles.filter(item => item.id !== metadata.id), metadata];
      if (state.loseUpload) { state.loseUpload = false; throw Error('lost response'); }
      return Response.json({ import_id: '1', article: metadata });
    }
    throw Error(`Unexpected route: ${url}`);
  });
  await f.bridge.bind('1');
  await seedAnalysis(f.ws);
  const output = async prepared => {
    await f.ws.writeJson(`${prepared.artifact_dir}/article.json`, article);
    await f.ws.write(`${prepared.artifact_dir}/block_invite.png`, png);
    await f.ws.writeJson(`${prepared.artifact_dir}/lint_report.json`, { all_passed: true, global_warnings: [] });
  };
  const write = async () => { const prepared = await f.bridge.prepare({ title: article.title, article_type: 'how-to' }); await output(prepared); return prepared; };
  const upload = async () => { const prepared = await write(); await f.bridge.complete({ run_id: prepared.run_id, completed: true }); return prepared; };
  return { ...f, state, write, upload, output };
}

test('sync refreshes project settings and remote-only inventory without downloading content', async t => {
  const f = await setup(t);
  f.state.project = { id: '1', name: 'Renamed remotely', help_centre_url: 'https://renamed.example.com' };
  f.state.articles = [{ ...remote, title: 'Only on the server', local_article_id: null, section_id: null, deleted_at: null }];
  const result = await f.bridge.sync();
  assert.equal(result.project.name, 'Renamed remotely');
  assert.equal(result.writing_style, 'Friendly');
  assert.equal(result.articles[0].sync_status, 'remote_only');
  assert.equal(result.articles[0].remote.editor_url, remote.editor_url);
  assert.equal(await f.ws.exists('output/articles'), false);
  assert.ok(f.state.calls.every(call => call.method === 'GET'));
  await assert.rejects(f.bridge.prepare({ title: 'Only on the server', article_type: 'how-to' }), { code: 'article_exists' });
  assert.equal(await f.ws.exists('.rtfm/supportpages/active-run.json'), false);
});

test('remote edits refresh observed metadata without advancing the upload baseline; conflicts block uploads', async t => {
  const f = await setup(t), prepared = await f.upload();
  const statePath = '.rtfm/supportpages/articles/invite-a-teammate.json';
  const before = await f.ws.json(statePath);
  f.state.articles[0] = { ...f.state.articles[0], title: 'Changed in editor', revision: 'b'.repeat(64), accepted_bundle_hash: null };
  assert.equal((await f.bridge.sync()).articles[0].sync_status, 'remote_changed');
  assert.deepEqual(await f.ws.json(statePath), before);
  await f.ws.writeJson(`${prepared.artifact_dir}/article.json`, { ...article, title: 'Changed locally too' });
  assert.equal((await f.bridge.sync()).articles[0].sync_status, 'conflict');
  const posts = f.state.calls.filter(call => call.method === 'POST').length;
  await assert.rejects(f.bridge.upload('invite-a-teammate'), { code: 'revision_conflict' });
  assert.equal(f.state.calls.filter(call => call.method === 'POST').length, posts);
  const delivery = await f.bridge.complete({ run_id: prepared.run_id, completed: true });
  assert.equal(delivery.article.revision, 'b'.repeat(64));
});

test('deleted, unavailable and restored articles remain distinct; sync never deletes local work', async t => {
  const f = await setup(t), prepared = await f.upload();
  const original = { ...f.state.articles[0] };
  f.state.articles[0] = { id: original.id, local_article_id: original.local_article_id, title: original.title, section_id: null, deleted_at: '2026-09-11T12:00:00Z' };
  assert.equal((await f.bridge.sync()).articles[0].sync_status, 'deleted_remotely');
  await assert.rejects(f.bridge.upload('invite-a-teammate'), { code: 'article_deleted' });
  f.state.articles = [];
  assert.equal((await f.bridge.sync()).articles[0].sync_status, 'unavailable');
  await assert.rejects(f.bridge.upload('invite-a-teammate'), { code: 'article_unavailable' });
  f.state.articles = [original];
  assert.equal((await f.bridge.sync()).articles[0].sync_status, 'synced');
  assert.deepEqual(await f.ws.json(`${prepared.artifact_dir}/article.json`), article);
});

test('local edits remain visible even when the server confirms the last uploaded bundle', async t => {
  const f = await setup(t), prepared = await f.upload();
  await f.ws.writeJson(`${prepared.artifact_dir}/article.json`, { ...article, title: 'New local wording' });
  const result = await f.bridge.sync();
  assert.equal(result.articles[0].sync_status, 'local_changes');
  assert.equal(result.articles[0].remote.title, article.title);
});

test('offline and incomplete inventories retain the last successful snapshot', async t => {
  const f = await setup(t);
  await f.bridge.sync();
  const before = await f.ws.read('.rtfm/supportpages/sync.json');
  f.state.offline = true;
  await assert.rejects(f.bridge.sync(), { code: 'network_error' });
  assert.deepEqual(await f.ws.read('.rtfm/supportpages/sync.json'), before);
  f.state.offline = false;
  const request = f.bridge.api.request.bind(f.bridge.api);
  f.bridge.api.request = async (method, route) => route.endsWith('/sync')
    ? { project_id: '1', through_id: '1000', next_cursor: '5', articles: [{ ...remote, title: 'Page one', local_article_id: null, section_id: null, deleted_at: null }] }
    : route.includes('after_id') ? Promise.reject(Error('failed second page')) : request(method, route);
  await assert.rejects(f.bridge.sync(), /failed second page/);
  assert.deepEqual(await f.ws.read('.rtfm/supportpages/sync.json'), before);
});

test('sync follows keyset pages and rejects responses for a different project', async t => {
  const f = await setup(t), request = f.bridge.api.request.bind(f.bridge.api);
  f.bridge.api.request = async (method, route) => route.includes('/sync') ? {
    project_id: '1', through_id: '6', next_cursor: route.includes('?') ? null : '5',
    articles: [{ ...remote, id: route.includes('?') ? '6' : '5', local_article_id: null, title: 'Same title', section_id: null, deleted_at: null }],
  } : request(method, route);
  const result = await f.bridge.sync();
  assert.equal(result.articles.length, 2);
  assert.deepEqual(result.articles.map(item => item.remote.id), ['5', '6']);
  f.bridge.api.request = async () => ({ ...context, article_sync: true, project: { id: '2', name: 'Other' } });
  await assert.rejects(f.bridge.sync(), { code: 'destination_mismatch' });
});

test('switching projects separates same-title outputs and switching back restores upload history', async t => {
  const f = await setup(t), first = await f.upload();
  const original = [...f.state.articles];
  await replaceConnection(f.bridge, '1', '2');
  f.state.articles = [];
  assert.equal((await f.bridge.sync()).articles.length, 0);
  const second = await f.write();
  assert.notEqual(second.artifact_dir, first.artifact_dir);
  assert.deepEqual(await f.ws.json(`${first.artifact_dir}/article.json`), article);
  await f.bridge.cancel(second.run_id, true);
  const switched = await replaceConnection(f.bridge, '2', '1');
  assert.equal(switched.restored_history, true);
  f.state.articles = original;
  const result = await f.bridge.sync();
  assert.equal(result.articles.length, 1);
  assert.equal(result.articles[0].run_id, first.run_id);
  assert.equal(result.articles[0].remote.id, original[0].id);
  assert.equal((await f.bridge.complete({ run_id: first.run_id, completed: true })).editor_url, remote.editor_url);
  assert.deepEqual(await f.ws.json(`${first.artifact_dir}/article.json`), article);
  assert.deepEqual(await f.ws.json(`${second.artifact_dir}/article.json`), article);
});

test('a lost upload response is associated by local ID and retries the existing remote draft', async t => {
  const f = await setup(t), prepared = await f.write();
  f.state.loseUpload = true;
  await assert.rejects(f.bridge.complete({ run_id: prepared.run_id, completed: true }), { code: 'network_error' });
  const synced = await f.bridge.sync();
  assert.equal(synced.articles.length, 1);
  assert.equal(synced.articles[0].remote.local_article_id, (await f.bridge.runs.read(prepared.run_id)).local_article_id);
  assert.equal(synced.articles[0].sync_status, 'synced');
  await f.bridge.complete({ run_id: prepared.run_id, completed: true });
  assert.equal(f.state.articles.length, 1);
});

test('CLI sync presents editor links and supports structured output', async t => {
  const f = await setup(t), lines = [];
  f.state.articles = [{ ...remote, title: 'Remote article', local_article_id: randomUUID(), section_id: null, deleted_at: null }];
  const deps = { installRoot: f.root, ui: { line: value => lines.push(value), ok: value => lines.push(value) },
    sessionFactory: () => ({ bridge: async () => f.bridge, close() {} }), run: async () => ({ code: 1 }) };
  await runCli({ command: 'sync', workspace: f.root, 'config-dir': `${f.root}/config`, json: true }, deps);
  assert.equal(JSON.parse(lines.pop()).articles[0].sync_status, 'remote_only');
  await runCli({ command: 'sync', workspace: f.root, 'config-dir': `${f.root}/config` }, deps);
  assert.ok(lines.includes(remote.editor_url));
});

test('failed switch-back rolls restored history back into its archive', async t => {
  const f = await setup(t), first = await f.upload();
  await replaceConnection(f.bridge, '1', '2');
  f.state.articles = [];
  const original = f.bridge.ws.writeJson.bind(f.bridge.ws);
  f.bridge.ws.writeJson = async (file, value) => { if (file.endsWith('/binding.json')) throw Error('binding save failed'); return original(file, value); };
  await assert.rejects(replaceConnection(f.bridge, '2', '1'), /binding save failed/);
  f.bridge.ws.writeJson = original;
  assert.equal((await f.bridge.binding()).project_id, '2');
  assert.equal((await f.bridge.sync()).articles.length, 0);
  await replaceConnection(f.bridge, '2', '1');
  assert.equal((await f.bridge.runs.read(first.run_id)).project_id, '1');
});

test('legacy article records are reconciled from matching archives without adopting another project', async t => {
  const f = await setup(t), prepared = await f.upload();
  const local = await f.bridge.runs.read(prepared.run_id);
  const state = await f.ws.json('.rtfm/supportpages/articles/invite-a-teammate.json');
  const archive = '.rtfm/supportpages/archives/project-1-legacy';
  await f.ws.writeJson(`${archive}/binding.json`, { version: 1, project_id: '1', api_origin: f.bridge.api.origin });
  await f.ws.writeJson(`${archive}/runs/${local.id}/run.json`, local);
  await f.ws.writeJson(`${archive}/articles/invite-a-teammate.json`, state);
  await rename(await f.ws.resolve('.rtfm/supportpages/bundles'), await f.ws.resolve(`${archive}/bundles`));
  await rm(await f.ws.resolve('.rtfm/supportpages/runs'), { recursive: true });
  await rm(await f.ws.resolve('.rtfm/supportpages/articles'), { recursive: true });
  const result = await f.bridge.sync();
  assert.equal(result.articles.filter(item => item.local_article_id === local.local_article_id).length, 1);
  assert.equal(result.articles[0].sync_status, 'synced');
  await f.ws.writeJson(`${archive}/binding.json`, { version: 1, project_id: '2', api_origin: f.bridge.api.origin });
  assert.equal((await f.bridge.sync()).articles.length, 1);
  assert.equal((await f.bridge.sync()).articles[0].sync_status, 'remote_only');
});

test('resuming unfinished work fetches changed project guidance without changing its prose', async t => {
  const f = await setup(t), prepared = await f.write();
  await f.bridge.cancel(prepared.run_id, true);
  f.state.project.name = 'New remote name';
  const retried = await f.bridge.retryArticle({ run_id: prepared.run_id, stopped: true });
  const taskContext = await f.ws.json(`.rtfm/supportpages/runs/${prepared.run_id}/context.json`);
  assert.equal(taskContext.project_name, 'New remote name');
  assert.equal(retried.run_id, prepared.run_id);
  assert.deepEqual(await f.ws.json(`${prepared.artifact_dir}/article.json`), article);
});

test('an explicitly requested separate article gets independent output and identity', async t => {
  const f = await setup(t), first = await f.upload();
  const second = await f.bridge.prepare({ title: article.title, article_type: 'how-to', allow_duplicate: true });
  assert.notEqual(first.artifact_dir, second.artifact_dir);
  assert.notEqual((await f.bridge.runs.read(first.run_id)).local_article_id, (await f.bridge.runs.read(second.run_id)).local_article_id);
});

test('a lost milestone response can recover its own preview but a kept draft blocks further writing', async t => {
  const f = await setup(t), prepared = await f.write();
  const run = await f.bridge.runs.read(prepared.run_id), attempt = randomUUID();
  await f.bridge.lock(() => f.bridge.runs.save({ ...run, progress: { attempt, sequence: 1, article: remote } }));
  f.state.articles = [{ ...remote, revision: 'b'.repeat(64), title: article.title, local_article_id: run.local_article_id, section_id: null,
    deleted_at: null, generation: { run_id: run.id, attempt, state: 'running' } }];
  assert.equal((await f.bridge.sync()).articles[0].sync_status, 'local_changes');
  await f.bridge.lock(() => new ProjectSync(f.bridge).guard(run.local_article_id));
  f.state.articles[0].generation.state = 'kept';
  await assert.rejects(f.bridge.lock(() => new ProjectSync(f.bridge).guard(run.local_article_id)), { code: 'run_closed' });
});

test('a remote article that remembers another local identity keeps its local link; the local record wins', async t => {
  const f = await setup(t), prepared = await f.upload();
  f.state.articles[0] = { ...f.state.articles[0], local_article_id: randomUUID() };
  const result = await f.bridge.sync();
  assert.equal(result.articles.length, 1);
  assert.equal(result.articles[0].run_id, prepared.run_id);
  assert.equal(result.articles[0].remote.id, f.state.articles[0].id);
  assert.equal(result.articles[0].sync_status, 'synced');
  assert.equal(result.articles[0].identity_mismatch, true);
  assert.equal((await f.bridge.sync()).articles.filter(item => item.identity_mismatch).length, 1);
});
