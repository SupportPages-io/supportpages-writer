import test from 'node:test';
import assert from 'node:assert/strict';
import { rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { fixture, seedAnalysis, context } from './helpers.mjs';
import { LocalSetup } from '../dist/local-setup.js';

test('a connected repository cannot prepare or finalize articles before full analysis', async t => {
  const f = await fixture(t, async url => Response.json(url.endsWith('/projects') ? { projects: [context.project] } : context));
  await f.bridge.bind('1'); await f.output();
  const status = await f.bridge.status();
  assert.equal(status.status, 'ready'); assert.equal(status.generation_ready, false);
  assert.equal(status.analysis.status, 'required');
  await assert.rejects(f.bridge.prepare({ title: 'First article', article_type: 'how-to' }), { code: 'analysis_required' });
  await assert.rejects(f.bridge.finalize({ artifact_dir: 'output/articles/invite', completed: true }), { code: 'analysis_required' });
  assert.equal(await f.ws.exists('.rtfm/supportpages/active-run.json'), false);
  await seedAnalysis(f.ws);
  assert.equal((await f.bridge.status()).generation_ready, true);
  const prepared = await f.bridge.prepare({ title: 'First article', article_type: 'how-to' });
  const data = await f.ws.json(path.relative(f.root, prepared.environment.RTFM_CONTEXT_FILE));
  assert.equal(data.project_overview, 'Helps people work together.');
});

test('readiness validates full artifacts, while allowing generators to enrich the cache', async t => {
  const f = await fixture(t); await seedAnalysis(f.ws);
  await f.ws.writeJson('.rtfm/project_map.json', { framework: 'test', route_index: { home: { primary_view: 'home.html' } } });
  assert.equal((await f.bridge.setup.analysis()).status, 'ready');
  await f.ws.write('output/detect-project/summary.md', 'Changed analysis without acceptance');
  assert.equal((await f.bridge.setup.analysis()).status, 'invalid');
  await seedAnalysis(f.ws);
  await f.ws.write('.rtfm/branding.css', ' ');
  assert.equal((await f.bridge.setup.analysis()).status, 'invalid');
  await seedAnalysis(f.ws);
  await rm(path.join(f.root, 'output/detect-project/overview.txt'));
  assert.equal((await f.bridge.setup.analysis()).status, 'invalid');
});

test('native project analysis requires its appropriate capability index', async t => {
  const f = await fixture(t); await seedAnalysis(f.ws);
  for (const [app_type, key] of Object.entries({ terminal: 'command_index', mobile: 'screen_index', win32: 'dialog_index', macos: 'view_index' })) {
    await f.ws.writeJson('.rtfm/project_map.json', { framework: 'test', app_type, route_index: {} });
    await assert.rejects(f.bridge.setup.accept('output/detect-project', 'test', '1'));
    await f.ws.writeJson('.rtfm/project_map.json', { framework: 'test', app_type, route_index: {}, [key]: { home: {} } });
    await f.bridge.setup.accept('output/detect-project', 'test', '1');
    assert.equal((await f.bridge.setup.analysis()).app_type, app_type);
  }
});

test('analysis receipts and local plans are scoped to workspace and destination', async t => {
  const f = await fixture(t); await seedAnalysis(f.ws);
  const dev = new LocalSetup(f.ws, '.rtfm/supportpages/dev/example');
  assert.equal((await dev.analysis()).status, 'required');
  await dev.accept('output/detect-project', 'test', '1');
  const receipt = await f.ws.json('.rtfm/supportpages/setup/analysis.json');
  await f.ws.writeJson('.rtfm/supportpages/setup/analysis.json', { ...receipt, workspace: '/another/workspace' });
  assert.equal((await f.bridge.setup.analysis()).status, 'required');
  const plan = await f.bridge.setup.plan('1');
  plan.recommendations.push({ id: 'local', title: 'Invite a colleague', description: 'Invite someone' });
  await f.bridge.setup.savePlan(plan);
  await assert.rejects(f.bridge.setup.plan('2'), { code: 'destination_mismatch' });
  assert.deepEqual((await dev.plan('2')).recommendations, []);
});

test('analysis does not accept output paths or symlinks outside its task area', async t => {
  const f = await fixture(t); await seedAnalysis(f.ws);
  await assert.rejects(f.bridge.setup.accept('output/detect-project-impostor', 'test', '1'), { code: 'invalid_analysis' });
  await rm(path.join(f.root, '.rtfm/branding.css'));
  await symlink(path.join(f.root, 'output/detect-project/summary.md'), path.join(f.root, '.rtfm/branding.css'));
  assert.equal((await f.bridge.setup.analysis()).status, 'invalid');
});

test('nested application caches remain in place and writing and recovery use that application with the tracked output directory', async t => {
  const f = await fixture(t); await seedAnalysis(f.ws); await f.bridge.bind('1');
  for (const name of ['branding.json', 'project_map.json', 'branding.css']) {
    await f.ws.write(`apps/web/.rtfm/${name}`, await f.ws.read(`.rtfm/${name}`));
    await rm(path.join(f.root, '.rtfm', name));
  }
  await f.ws.writeJson('output/detect-project/analysis-target.json', { codebase_dir: 'apps/web' });
  await f.bridge.setup.accept('output/detect-project', 'fixture', '1');
  assert.equal((await f.bridge.setup.analysis()).codebase_dir, 'apps/web');
  assert.equal((await f.bridge.setup.analysis()).status, 'ready');
  assert.equal(await f.ws.exists('.rtfm/branding.json'), false);
  await f.ws.write('apps/web/.rtfm/branding.css', 'body { color: blue; }');
  assert.equal((await f.bridge.setup.analysis()).status, 'ready');
  const prepared = await f.bridge.prepare({ title: 'Nested guide', article_type: 'how-to' });
  assert.equal(prepared.task_brief.workspace, path.join(f.root, 'apps/web'));
  assert.equal(prepared.environment.RTFM_WORKSPACE, path.join(f.root, 'apps/web'));
  assert.equal(prepared.environment.RTFM_OUTPUT_DIR, path.join(f.root, '.rtfm/supportpages/work/1/nested-guide'));
  assert.equal(prepared.task_brief.artifact_dir, prepared.environment.RTFM_OUTPUT_DIR);
  // Local articles are capped at three screenshots; the engine enforces it.
  assert.equal(prepared.environment.RTFM_MAX_IMAGES, '3');
  assert.equal(prepared.artifact_dir, '.rtfm/supportpages/work/1/nested-guide');
  assert.equal((await f.bridge.runs.read(prepared.run_id)).codebase_dir, 'apps/web');
  await f.bridge.cancel(prepared.run_id, true);
  const retry = await f.bridge.retryArticle({ run_id: prepared.run_id, stopped: true });
  assert.equal(retry.task_brief.workspace, prepared.task_brief.workspace);
  assert.deepEqual(retry.task_brief.environment, prepared.task_brief.environment);
});

test('analysis target cannot escape the workspace or silently switch after acceptance', async t => {
  const f = await fixture(t); await seedAnalysis(f.ws);
  for (const codebase_dir of ['../escape', '/tmp', 'apps/../other', '']) {
    await f.ws.writeJson('output/detect-project/analysis-target.json', { codebase_dir });
    await assert.rejects(f.bridge.setup.accept('output/detect-project', 'fixture', '1'), { code: 'invalid_analysis' });
  }
  await symlink(f.root, path.join(f.root, 'linked'));
  await f.ws.writeJson('output/detect-project/analysis-target.json', { codebase_dir: 'linked' });
  await assert.rejects(f.bridge.setup.accept('output/detect-project', 'fixture', '1'), { code: 'invalid_path' });
  await f.ws.writeJson('output/detect-project/analysis-target.json', { codebase_dir: '.' });
  await f.bridge.setup.accept('output/detect-project', 'fixture', '1');
  await f.ws.writeJson('output/detect-project/analysis-target.json', { codebase_dir: 'other' });
  assert.equal((await f.bridge.setup.analysis()).codebase_dir, '.');
});
