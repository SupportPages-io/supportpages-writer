import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { rm, symlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { localFixture, fixture, article, remote, context } from './helpers.mjs';
import { mcp, result, blocked, scenarioFixture } from './scenario-helpers.mjs';
import { ApiClient } from '../dist/api.js';
import { Bridge } from '../dist/bridge.js';
import { Session } from '../dist/session.js';

const origin = 'https://app.supportpages.io';
function signedOut(f) {
  f.bridge.api = new ApiClient(origin, undefined, async () => assert.fail('local listing must not make network requests'));
}

test('MCP article inventory reads files without sign-in, setup, state records or writer startup', async t => {
  const f = await fixture(t);
  signedOut(f);
  await f.output();
  await f.ws.write('output/articles/another/index.md', '# Another guide\n\nSaved Markdown.');
  t.mock.method(globalThis, 'fetch', async () => assert.fail('must not make network requests'));
  t.mock.method(Bridge.prototype, 'resumeWriterCompletion', async () => assert.fail('must remain passive'));
  const session = new Session({ cwd: f.root, origin, dev: false, skillsDir: f.bridge.skillsDir, configDir: path.join(f.root, 'config') });
  const call = await mcp(t, session);
  for (const tool of ['list_articles', 'list_local_articles']) {
    const value = result(await call(tool));
    assert.equal(value.source, 'local');
    assert.deepEqual(value.articles.map(a => a.title), ['Another guide', 'Invite a teammate']);
    assert.equal(value.articles[0].export_path, path.join(f.root, 'output/articles/another/index.md'));
    assert.equal(value.articles[1].article_path, path.join(f.root, 'output/articles/invite/article.json'));
    assert.equal(value.next_cursor, null);
    assert.match(value.instructions, /Do not request sign-in/);
  }
  assert.equal(await f.ws.exists(f.bridge.stateRoot), false);
});

test('a signed-out linked workspace lists local files without changing its binding', async t => {
  const f = await fixture(t);
  await f.bridge.bind('1');
  const binding = await f.ws.read(`${f.bridge.stateRoot}/binding.json`);
  signedOut(f);
  await f.output();
  const call = await mcp(t, f.bridge);
  assert.equal(result(await call('list_articles')).articles[0].title, article.title);
  assert.deepEqual(await f.ws.read(`${f.bridge.stateRoot}/binding.json`), binding);
  blocked(await call('list_articles', { source: 'hosted' }), 'authentication_required');
  blocked(await call('list_articles', { after_id: '5' }), 'authentication_required');
  assert.equal(await f.ws.exists(`${f.bridge.stateRoot}/active-run.json`), false);
});

test('configured export directories and remaining Markdown are inventoried without Git or article state', async t => {
  const f = await localFixture(t, { export_dir: 'docs/help' });
  await f.ws.write('docs/help/invite/index.md', '# Invite a teammate\n');
  await f.output();
  const value = await f.bridge.listArticles();
  assert.equal(value.articles.length, 1);
  assert.equal(value.articles[0].export_path, path.join(f.root, 'docs/help/invite/index.md'));
  assert.equal(value.articles[0].article_path, path.join(f.root, 'output/articles/invite/article.json'));
  assert.ok(value.searched_directories.includes('docs/help'));
  await rm(await f.ws.resolve('output/articles/invite'), { recursive: true });
  assert.equal((await f.bridge.listArticles()).articles.length, 1);
});

test('deleted article files are not reported from stale state or retained bundles', async t => {
  const f = await localFixture(t);
  await f.output();
  const bundleDir = `${f.bridge.stateRoot}/bundles/${'a'.repeat(64)}`;
  await f.ws.writeJson(`${bundleDir}/article.json`, article);
  await f.ws.writeJson(`${f.bridge.stateRoot}/articles/invite.json`, {
    local_article_id: randomUUID(), artifact_dir: 'output/articles/invite', bundle_dir: bundleDir, bundle_hash: 'a'.repeat(64),
  });
  assert.equal((await f.bridge.listArticles()).articles.length, 1);
  await rm(await f.ws.resolve('output/articles/invite'), { recursive: true });
  const value = await f.bridge.listArticles();
  assert.deepEqual(value.articles, []);
  assert.match(value.instructions, /says nothing about hosted articles/);
});

for (const scenario of ['account_only', 'connected']) {
  test(`${scenario}: default inventory remains hosted and explicit local inventory is offline`, async t => {
    const f = await scenarioFixture(t, scenario), call = await mcp(t, f.bridge);
    await f.output();
    const hosted = result(await call('list_articles'));
    assert.equal(hosted.articles[0].id, remote.id);
    const calls = f.calls.length;
    assert.equal(result(await call('list_articles', { source: 'local' })).source, 'local');
    assert.equal(f.calls.length, calls);
  });
}

test('local mode remains local even when device credentials are present', async t => {
  const f = await fixture(t, async () => assert.fail('must not contact hosted service'));
  await f.bridge.saveLocal({ version: 1, export_dir: 'output/articles' });
  await f.output();
  assert.equal((await f.bridge.listArticles()).articles.length, 1);
});

test('expired credentials fall back only for an automatic first-page article listing', async t => {
  let expired = false;
  const f = await fixture(t, async () => expired ? Response.json({}, { status: 401 }) : Response.json(context));
  await f.bridge.bind('1');
  expired = true;
  await f.output();
  assert.equal((await f.bridge.listArticles()).source, 'local');
  await assert.rejects(f.bridge.listArticles(undefined, 'hosted'), { code: 'authentication_required' });
  await assert.rejects(f.bridge.listArticles('5'), { code: 'authentication_required' });
});

test('hosted permission failures never masquerade as a local inventory', async t => {
  let denied = false;
  const f = await fixture(t, async () => denied ? Response.json({}, { status: 403 }) : Response.json(context));
  await f.bridge.bind('1');
  denied = true;
  await f.output();
  await assert.rejects(f.bridge.listArticles(), { code: 'permission_denied' });
});

test('unreadable local files are reported and paths cannot escape the workspace', async t => {
  const f = await localFixture(t);
  await f.ws.write('output/articles/broken/article.json', '{broken');
  const value = await f.bridge.listArticles();
  assert.equal(value.warnings.length, 1);
  assert.deepEqual(value.articles, []);
  await symlink('/etc/passwd', await f.ws.resolve('output/articles/broken/index.md'));
  await assert.rejects(f.bridge.listArticles(), { code: 'invalid_path' });
});
