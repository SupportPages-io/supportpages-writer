import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { localFixture, article, png } from './helpers.mjs';

async function setup(t, exportDir = 'output/articles', automatic = false) {
  const f = await localFixture(t, { export_dir: exportDir });
  const prepared = await f.bridge.prepare({ title: 'Invite', article_type: 'how-to' });
  await f.bridge.updateRun({ run_id: prepared.run_id, event: 'started', execution_mode: 'foreground' });
  if (!automatic) f.bridge.relay.stop();
  return { ...f, prepared, directory: prepared.artifact_dir, target: `${exportDir}/invite`,
    tick: () => f.bridge.relay.tick(prepared.run_id) };
}

test('local previews export readable Markdown and finished PNGs while all working files remain private', async t => {
  for (const exportDir of ['output/articles', 'docs/help']) {
    const f = await setup(t, exportDir);
    assert.equal(f.directory, '.rtfm/supportpages/work/local/invite');
    await f.tick();
    assert.equal(await f.ws.exists(f.target), false);
    await f.ws.writeJson(`${f.directory}/article.json`, article);
    await f.ws.write(`${f.directory}/block_invite.html`, '<main>Mockup</main>');
    await f.ws.writeJson(`${f.directory}/view_sources.json`, { source: 'private source ledger' });
    await f.ws.writeJson(`${f.directory}/lint_report.json`, { all_passed: false });
    await f.tick();
    const markdown = `${f.target}/index.md`;
    assert.match((await f.ws.read(markdown)).toString(), /Invite someone/);
    assert.doesNotMatch((await f.ws.read(markdown)).toString(), /block_invite.png/);
    assert.deepEqual(await readdir(path.join(f.root, f.target)), ['index.md']);
    const status = await f.bridge.runs.progress(f.prepared.run_id);
    assert.equal(status.phase, 'writing');
    assert.equal(status.generation_completed_locally, false);
    assert.equal(status.export_path, undefined);
    assert.equal(status.local_preview_path, path.join(f.root, markdown));

    await f.ws.write(`${f.directory}/block_invite.png`, png.subarray(0, 30));
    await f.tick();
    assert.equal(await f.ws.exists(`${f.target}/block_invite.png`), false);
    await f.ws.write(`${f.directory}/block_invite.png`, png);
    await f.tick();
    assert.match((await f.ws.read(markdown)).toString(), /\(\.\/block_invite.png\)/);
    assert.deepEqual(await f.ws.read(`${f.target}/block_invite.png`), png);
    assert.deepEqual((await readdir(path.join(f.root, f.target))).sort(), ['block_invite.png', 'index.md']);

    const mtime = (await stat(path.join(f.root, markdown))).mtimeMs;
    await f.tick();
    assert.equal((await stat(path.join(f.root, markdown))).mtimeMs, mtime);
    await assert.rejects(f.bridge.complete({ run_id: f.prepared.run_id, completed: true }), { code: 'quality_check_failed' });
    assert.equal((await f.bridge.runs.read(f.prepared.run_id)).phase, 'failed');
    assert.equal(await f.ws.exists(markdown), true);
    await f.bridge.retryArticle({ run_id: f.prepared.run_id, stopped: true });
    await f.ws.writeJson(`${f.directory}/lint_report.json`, { all_passed: true });
    const saved = await f.bridge.complete({ run_id: f.prepared.run_id, completed: true });
    assert.equal(saved.status, 'saved');
    assert.equal(saved.markdown_path, path.join(f.root, markdown));
    assert.deepEqual((await readdir(path.join(f.root, f.target))).sort(), ['block_invite.png', 'index.md']);
  }
});

test('partial rewrites preserve the last valid local preview; removed images are removed from the export', async t => {
  const f = await setup(t);
  await f.output();
  await f.tick();
  const before = await f.ws.read(`${f.target}/index.md`);
  await f.ws.write(`${f.directory}/article.json`, '{');
  await f.ws.write(`${f.directory}/block_invite.png`, png.subarray(0, 30));
  await f.tick();
  assert.deepEqual(await f.ws.read(`${f.target}/index.md`), before);
  assert.deepEqual(await f.ws.read(`${f.target}/block_invite.png`), png);
  await f.ws.writeJson(`${f.directory}/article.json`, { ...article, title: 'Updated instructions' });
  await f.tick();
  assert.match((await f.ws.read(`${f.target}/index.md`)).toString(), /^# Updated instructions/);
  assert.match((await f.ws.read(`${f.target}/index.md`)).toString(), /block_invite.png/);
  assert.deepEqual(await f.ws.read(`${f.target}/block_invite.png`), png);
  const replacement = Buffer.from(png); replacement.writeUInt32BE(2, 16);
  await f.ws.write(`${f.directory}/block_invite.png`, replacement);
  await f.tick();
  assert.deepEqual(await f.ws.read(`${f.target}/block_invite.png`), replacement);
  await f.ws.writeJson(`${f.directory}/article.json`, { ...article, blocks: [article.blocks[0]] });
  await f.tick();
  assert.doesNotMatch((await f.ws.read(`${f.target}/index.md`)).toString(), /block_invite.png/);
  assert.equal(await f.ws.exists(`${f.target}/block_invite.png`), false);
  assert.equal(await f.ws.exists(`${f.directory}/block_invite.png`), true);
});

test('scheduled local observation writes before completion and cancellation leaves the last preview in place', async t => {
  const f = await setup(t, 'docs/help', true);
  await f.output();
  const deadline = Date.now() + 6000;
  while (!await f.ws.exists(`${f.target}/index.md`)) {
    assert.ok(Date.now() < deadline, 'local preview must appear without a completion call');
    await delay(20);
  }
  const run = await f.bridge.runs.read(f.prepared.run_id);
  assert.equal(run.writer_completed_at, undefined);
  assert.equal(run.phase, 'writing');
  await f.bridge.cancel(f.prepared.run_id, true);
  const before = await f.ws.read(`${f.target}/index.md`);
  await f.ws.writeJson(`${f.directory}/article.json`, { ...article, title: 'After cancellation' });
  await f.tick();
  assert.deepEqual(await f.ws.read(`${f.target}/index.md`), before);
});

test('a preview export failure is retryable and destination settings changes apply to future runs', async t => {
  const f = await setup(t);
  await f.output();
  // A file in place of a directory causes a real filesystem export failure.
  await f.ws.write(f.target, 'obstacle');
  await f.tick();
  let status = await f.bridge.runs.progress(f.prepared.run_id);
  assert.equal(status.phase, 'writing');
  assert.ok(status.synchronization_error);
  assert.equal(status.error, undefined);
  const { rm } = await import('node:fs/promises');
  await rm(path.join(f.root, f.target));
  await f.bridge.saveLocal({ version: 1, export_dir: 'docs/new' });
  await f.tick();
  status = await f.bridge.runs.progress(f.prepared.run_id);
  assert.equal(status.synchronization_error, undefined);
  assert.equal(await f.ws.exists(`${f.target}/index.md`), true);
  assert.equal(await f.ws.exists('docs/new'), false);
  const saved = await f.bridge.complete({ run_id: f.prepared.run_id, completed: true });
  assert.equal(saved.markdown_path, path.join(f.root, f.target, 'index.md'));
});

test('local preparation preserves existing exported articles and legacy local runs remain retryable', async t => {
  const f = await localFixture(t, { export_dir: 'docs/help' });
  await f.ws.write('docs/help/invite/index.md', '# Existing article');
  await assert.rejects(f.bridge.prepare({ title: 'Invite', article_type: 'how-to' }), { code: 'output_exists' });
  assert.equal((await f.ws.read('docs/help/invite/index.md')).toString(), '# Existing article');
  const legacy = await setup(t);
  await legacy.bridge.cancel(legacy.prepared.run_id, true);
  const run = await legacy.bridge.runs.read(legacy.prepared.run_id);
  await legacy.bridge.runs.save({ ...run, artifact_dir: 'output/articles/invite', local_export: undefined });
  await legacy.bridge.retryArticle({ run_id: run.id, stopped: true });
  await legacy.output();
  assert.equal((await legacy.bridge.complete({ run_id: run.id, completed: true })).status, 'saved');
});
