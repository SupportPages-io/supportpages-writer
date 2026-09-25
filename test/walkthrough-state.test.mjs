import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../dist/server.js';
import { Walkthroughs } from '../dist/walkthroughs.js';
import { ProjectSync } from '../dist/sync.js';
import { writerAction } from '../dist/actions.js';
import { fixture, localFixture, context } from './helpers.mjs';
import { runCli } from '../scripts/lib/cli.mjs';

const metadata = { ...context, article_sync: true, walkthrough_sync: true, repository_connection: { ...context.repository_connection,
  writer: { version: 1, actions: Object.fromEntries(writerAction.options.map(action => [action, { action, allowed: true, execution: 'remote', required_scopes: ['read'], next_step: null }])) } } };
const video = { id: '5', project_id: '1', article_id: '9', title: 'Invite a teammate', slug: 'invite', revision: 'a'.repeat(64),
  generation_status: 'completed', ready: true, narrated: false, shared: false, publication_pending: true, public_on_article: false,
  review_url: 'https://app.supportpages.io/projects/example/walkthroughs?walkthrough=5', playback_url: 'https://app.supportpages.io/projects/example/walkthroughs?walkthrough=5',
  public_url: null, article_public_url: null, assets: { video: true, narrated_video: false, subtitles: false, transcript: false, poster: false },
  created_at: '2026-09-21T12:00:00Z', updated_at: '2026-09-21T12:00:00Z', generated_at: '2026-09-21T12:00:00Z', shared_at: null, error: null };
const page = (rows, extra = {}) => ({ project_id: '1', through_id: '99', next_cursor: null, walkthroughs: rows, ...extra });

async function setup(t) {
  const state = { context: structuredClone(metadata), rows: [structuredClone(video)], calls: [], failure: null, page: null };
  const f = await fixture(t, async (url, init) => {
    state.calls.push({ url, method: init.method });
    if (url.endsWith('/context')) return Response.json(state.context);
    if (url.includes('/sync')) return Response.json({ project_id: '1', through_id: '0', next_cursor: null, articles: [] });
    if (state.failure) return Response.json({ error: { code: state.failure } }, { status: 403 });
    if (/walkthroughs\/\d+$/.test(url)) return Response.json(state.rows[0]);
    if (url.includes('/walkthroughs')) return Response.json(state.page ? state.page(new URL(url)) : page(state.rows));
    throw Error(`Unexpected request: ${url}`);
  });
  await f.bridge.bind('1');
  return { ...f, state, videos: new Walkthroughs(f.bridge) };
}

test('MCP lists and reads remote videos and transcripts without starting work or needing local artifacts', async t => {
  const f = await setup(t);
  f.state.rows[0] = { ...video, transcript_text: 'Choose Invite.', transcript_omitted: false, assets: { ...video.assets, transcript: true } };
  const server = createServer(f.bridge), client = new Client({ name: 'videos', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);
  t.after(() => client.close());
  assert.match(client.getInstructions(), /call supportpages_list_walkthroughs, then supportpages_get_walkthrough/);
  assert.match(client.getInstructions(), /do not substitute a filesystem search/);
  const tools = (await client.listTools()).tools;
  for (const name of ['list_walkthroughs', 'get_walkthrough']) {
    const tool = tools.find(tool => tool.name === `supportpages_${name}`);
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.destructiveHint, false);
  }
  const listed = await client.callTool({ name: 'supportpages_list_walkthroughs', arguments: { article_id: '9' } });
  assert.equal(listed.structuredContent.result.walkthroughs[0].id, '5');
  const detail = await client.callTool({ name: 'supportpages_get_walkthrough', arguments: { walkthrough_id: '5' } });
  assert.equal(detail.structuredContent.result.transcript_text, 'Choose Invite.');
  assert.equal(detail.structuredContent.result.public_url, null);
  assert.ok(f.state.calls.every(call => call.method === 'GET'));
  assert.equal(await f.ws.exists(`${f.bridge.stateRoot}/active-run.json`), false);
  assert.equal(await f.ws.exists(`${f.bridge.stateRoot}/operations`), false);
});

test('sync discovers remote videos, tracks revisions and never presents missing videos as current', async t => {
  const f = await setup(t);
  let result = await f.bridge.sync();
  assert.equal(result.walkthroughs.items[0].sync_status, 'remote_only');
  assert.equal((await f.bridge.sync()).walkthroughs.items[0].sync_status, 'synced');
  f.state.rows[0] = { ...video, shared: true, public_url: 'https://example.supportpages.io/walkthroughs/invite', revision: 'b'.repeat(64) };
  result = await f.bridge.sync();
  assert.equal(result.walkthroughs.items[0].sync_status, 'remote_changed');
  assert.equal(result.walkthroughs.counts.changed, 1);
  f.state.rows = [];
  result = await f.bridge.sync();
  assert.equal(result.walkthroughs.items[0].sync_status, 'unavailable');
  assert.equal(result.walkthroughs.items[0].remote, null);
  assert.equal(result.walkthroughs.items[0].last_known.id, '5');
  assert.equal((await f.bridge.sync()).walkthroughs.counts.unavailable, 1);
  f.state.rows = [video];
  assert.equal((await f.bridge.listLocal()).walkthroughs.items[0].remote.id, '5');
});

test('failed or malformed paginated video refresh preserves the combined snapshot', async t => {
  const f = await setup(t);
  await f.bridge.sync();
  const before = await f.ws.read(`${f.bridge.stateRoot}/sync.json`);
  f.state.page = url => url.searchParams.has('after_id') ? page([video], { project_id: '2' }) : page([video], { next_cursor: '5' });
  await assert.rejects(f.bridge.sync(), { code: 'invalid_response' });
  assert.deepEqual(await f.ws.read(`${f.bridge.stateRoot}/sync.json`), before);
  f.state.page = () => page([video], { next_cursor: '4' });
  await assert.rejects(f.bridge.sync(), { code: 'invalid_response' });
  assert.deepEqual(await f.ws.read(`${f.bridge.stateRoot}/sync.json`), before);
  f.state.failure = 'permission_denied';
  await assert.rejects(f.bridge.sync(), { code: 'permission_denied' });
  assert.deepEqual(await f.ws.read(`${f.bridge.stateRoot}/sync.json`), before);
});

test('video inventory pagination follows stable bounds and rejects wrong identities and filters', async t => {
  const f = await setup(t);
  f.state.page = url => url.searchParams.has('after_id') ? page([{ ...video, id: '6' }]) : page([video], { next_cursor: '5' });
  assert.equal((await f.bridge.sync()).walkthroughs.counts.remote, 2);
  assert.ok(f.state.calls.some(call => call.url.includes('after_id=5&through_id=99')));
  await assert.rejects(f.videos.get('6'), { code: 'invalid_response' });
  await assert.rejects(f.videos.list({ article_id: '8' }), { code: 'invalid_response' });
  f.state.rows = [{ ...video, project_id: '2' }];
  await assert.rejects(f.videos.get('5'), { code: 'invalid_response' });
  f.state.rows = [{ ...video, review_url: 'https://another.example/private' }];
  await assert.rejects(f.videos.get('5'), { code: 'invalid_response' });
});

test('older servers retain article sync and give explicit update guidance for video reads', async t => {
  const f = await setup(t);
  delete f.state.context.walkthrough_sync;
  assert.equal((await f.bridge.sync()).walkthroughs.status, 'unsupported');
  await assert.rejects(f.videos.list(), { code: 'server_update_required' });
  await assert.rejects(f.videos.get('5'), { code: 'server_update_required' });
  assert.ok(!f.state.calls.some(call => call.url.includes('/walkthroughs')));
});

test('article upload guards do not depend on walkthrough availability or erase the video snapshot', async t => {
  const f = await setup(t);
  const before = (await f.bridge.sync()).walkthroughs;
  f.state.failure = 'permission_denied';
  const callCount = f.state.calls.filter(call => call.url.includes('/walkthroughs')).length;
  await new ProjectSync(f.bridge).guard('00000000-0000-4000-8000-000000000000');
  assert.equal(f.state.calls.filter(call => call.url.includes('/walkthroughs')).length, callCount);
  assert.deepEqual((await f.ws.json(`${f.bridge.stateRoot}/sync.json`)).walkthroughs, before);
});

test('anonymous local projects cannot inspect hosted videos or launch generation as fallback', async t => {
  const f = await localFixture(t);
  await assert.rejects(new Walkthroughs(f.bridge).list(), { code: 'authentication_required' });
  assert.equal(await f.ws.exists(`${f.bridge.stateRoot}/active-run.json`), false);
});

test('terminal sync shows video visibility and omits stale playback links for missing videos', async t => {
  const f = await setup(t), lines = [];
  const deps = { installRoot: f.root, ui: { line: value => lines.push(value), ok: value => lines.push(value) },
    sessionFactory: () => ({ bridge: async () => f.bridge, close() {} }), run: async () => ({ code: 1 }) };
  await runCli({ command: 'sync', workspace: f.root, 'config-dir': `${f.root}/config` }, deps);
  assert.ok(lines.includes('Synced 1 remote video walkthroughs.'));
  assert.ok(lines.includes(video.review_url));
  assert.ok(lines.some(line => line.includes('not on public article') && line.includes('no live share link')));
  f.state.rows = [];
  lines.length = 0;
  await runCli({ command: 'sync', workspace: f.root, 'config-dir': `${f.root}/config` }, deps);
  assert.ok(lines.some(line => line.includes('unavailable')));
  assert.ok(!lines.includes(video.review_url));
});

test('real Rails video detail and list contracts parse without losing state', async t => {
  const detail = JSON.parse(await readFile(new URL('fixtures/contracts/writer-walkthrough-detail-v1.json', import.meta.url), 'utf8'));
  const inventory = JSON.parse(await readFile(new URL('fixtures/contracts/writer-walkthrough-list-v1.json', import.meta.url), 'utf8'));
  const ctx = { ...metadata, project: { ...metadata.project, id: detail.project_id } };
  const f = await fixture(t, async url => Response.json(url.endsWith('/context') ? ctx : url.endsWith(`/walkthroughs/${detail.id}`) ? detail : inventory));
  // Contract fixtures are generated using Rails' test canonical app host.
  f.bridge.api.origin = new URL(detail.review_url).origin;
  await f.bridge.bind(detail.project_id);
  const videos = new Walkthroughs(f.bridge);
  assert.deepEqual(await videos.get(detail.id), detail);
  assert.deepEqual(await videos.list(), inventory);
});
