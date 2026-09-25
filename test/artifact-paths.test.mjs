import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { analysedFixture, seedAnalysis, article, context, remote } from './helpers.mjs';
import { ApiClient } from '../dist/api.js';

const input = { title: 'Invite', article_type: 'how-to' };
async function setup(t, dev = false) {
  const fetcher = async url => url.endsWith('/mcp/settings')
    ? Response.json({ preferences: { prefer_background: true, open_when_ready: false } })
    : url.endsWith('/article_imports') ? Response.json({ import_id: '1', article: remote }) : Response.json(context);
  const f = await analysedFixture(t, fetcher);
  if (dev) {
    f.bridge.api = new ApiClient('http://localhost:3000', 'test-secret', fetcher, true);
    await seedAnalysis(f.ws, f.bridge.stateRoot);
  }
  await f.bridge.bind('1');
  return f;
}

test('hosted artifacts stay under private state through retry and upload, including development', async t => {
  for (const dev of [false, true]) {
    const f = await setup(t, dev);
    const prepared = await f.bridge.prepare(input);
    const directory = `${f.bridge.stateRoot}/work/1/invite`;
    assert.equal(prepared.artifact_dir, directory);
    assert.equal(prepared.environment.RTFM_OUTPUT_DIR, path.join(f.root, directory));
    await f.output();
    await f.ws.write(`${directory}/block_invite.html`, '<main>Mockup</main>');
    await f.bridge.cancel(prepared.run_id, true);
    const retry = await f.bridge.retryArticle({ run_id: prepared.run_id, stopped: true });
    assert.equal(retry.task_brief.artifact_dir, directory);
    const done = await f.bridge.complete({ run_id: prepared.run_id, completed: true });
    assert.equal(done.status, 'ready_for_review');
    assert.equal(await f.ws.exists('output/articles'), false);
    assert.equal((await f.ws.read(`${directory}/block_invite.html`)).toString(), '<main>Mockup</main>');
    const saved = await f.ws.json(`${f.bridge.stateRoot}/articles/invite.json`);
    assert.equal(saved.artifact_dir, directory);
    assert.deepEqual(await f.ws.json(`${saved.bundle_dir}/article.json`), article);
    assert.equal(await f.ws.exists(`${saved.bundle_dir}/block_invite.html`), false);
  }
});

test('legacy scoped and unscoped runs resume and upload from their original directories', async t => {
  for (const scoped of [false, true]) {
    const f = await setup(t);
    const prepared = await f.bridge.prepare(input);
    await f.bridge.cancel(prepared.run_id, true);
    const scope = createHash('sha256').update(`false\n${f.bridge.api.origin}`).digest('hex').slice(0, 16);
    const directory = scoped ? `output/articles/${scope}-1/invite` : 'output/articles/invite';
    const run = await f.bridge.runs.read(prepared.run_id);
    await f.bridge.runs.save({ ...run, artifact_dir: directory });
    const retry = await f.bridge.retryArticle({ run_id: prepared.run_id, stopped: true });
    assert.equal(retry.task_brief.artifact_dir, directory);
    await f.output();
    await f.bridge.cancel(prepared.run_id, true);
    await assert.rejects(f.bridge.prepare(input), { code: 'output_exists' });
    await f.bridge.retryArticle({ run_id: prepared.run_id, stopped: true });
    assert.equal((await f.bridge.complete({ run_id: prepared.run_id, completed: true })).status, 'ready_for_review');
    assert.equal(await f.ws.exists('.rtfm/supportpages/work'), false);
  }
});

test('finalization rejects working directories belonging to another project or environment', async t => {
  const f = await setup(t);
  for (const directory of ['.rtfm/supportpages/work/2/invite', '.rtfm/supportpages/dev/0123456789abcdef/work/1/invite']) {
    await assert.rejects(f.bridge.finalize({ artifact_dir: directory, completed: true }), { code: 'destination_mismatch' });
  }
  const dev = await setup(t, true);
  await assert.rejects(dev.bridge.finalize({ artifact_dir: '.rtfm/supportpages/work/1/invite', completed: true }), { code: 'destination_mismatch' });
});
