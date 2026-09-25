import test from 'node:test';
import assert from 'node:assert/strict';
import { analysedFixture, capacity, context } from './helpers.mjs';
import { ApiClient } from '../dist/api.js';

test('full accounts get counts and action links before a writing task or output exists; retry fetches fresh capacity', async t => {
  let current = { ...capacity, used: 17, can_create: false };
  const f = await analysedFixture(t, async () => Response.json({ ...context, article_capacity: current }));
  await f.bridge.bind('1');
  await assert.rejects(f.bridge.prepare({ title: 'New guide', article_type: 'how-to' }), error => {
    assert.equal(error.code, 'plan_limit');
    assert.match(error.message, /generation has not started/);
    assert.match(error.message, /17 of 10/);
    assert.ok(error.message.includes(capacity.upgrade_url));
    assert.ok(error.message.includes(capacity.manage_articles_url));
    assert.deepEqual(error.details.article_capacity, current);
    return true;
  });
  assert.equal(await f.ws.exists('.rtfm/supportpages/active-run.json'), false);
  assert.equal(await f.ws.exists('.rtfm/supportpages/runs'), false);
  assert.equal(await f.ws.exists('output/articles'), false);
  current = { ...capacity, used: 9 };
  const prepared = await f.bridge.prepare({ title: 'New guide', article_type: 'how-to' });
  assert.equal(prepared.status, 'prepared');
});

test('unlimited capacity permits preparation and old servers cannot silently skip the check', async t => {
  let current = { ...capacity, used: 100, limit: null };
  const f = await analysedFixture(t, async () => Response.json({ ...context, article_capacity: current }));
  await f.bridge.bind('1');
  const run = await f.bridge.prepare({ title: 'New guide', article_type: 'how-to' });
  await f.bridge.cancel(run.run_id, true);
  current = undefined;
  await assert.rejects(f.bridge.prepare({ title: 'Another guide', article_type: 'how-to' }), { code: 'server_update_required' });
});

test('retrying a writer that has no remote draft checks capacity again', async t => {
  let current = capacity;
  const f = await analysedFixture(t, async () => Response.json({ ...context, article_capacity: current }));
  await f.bridge.bind('1');
  const run = await f.bridge.prepare({ title: 'New guide', article_type: 'how-to' });
  await f.bridge.cancel(run.run_id, true);
  current = { ...capacity, used: 10, can_create: false };
  await assert.rejects(f.bridge.retryArticle({ run_id: run.run_id, stopped: true }), { code: 'plan_limit' });
  assert.equal((await f.bridge.runs.read(run.run_id)).status, 'cancelled');
});

test('upload-time capacity errors preserve validated counts and links without arbitrary server text', async () => {
  const full = { ...capacity, used: 17, can_create: false };
  const api = new ApiClient('https://app.supportpages.io', 'test', async () => Response.json({
    error: { code: 'plan_limit', message: 'private server diagnostic', details: { article_capacity: full, secret: 'do not echo' } },
  }, { status: 403 }));
  await assert.rejects(api.request('POST', '/projects/1/generation_runs', {}), error => {
    assert.match(error.message, /17 of 10/);
    assert.match(error.message, /no regeneration/);
    assert.ok(error.message.includes(full.upgrade_url));
    assert.ok(error.message.includes(full.manage_articles_url));
    assert.deepEqual(error.details, { status: 403, article_capacity: full });
    assert.doesNotMatch(JSON.stringify(error), /private server diagnostic|do not echo/);
    return true;
  });
  for (const invalid of [{ ...full, upgrade_url: 'javascript:alert(1)' }, { ...full, used: -1 }, { ...full, limit: null }]) {
    const unsafe = new ApiClient('https://app.supportpages.io', 'test', async () => Response.json({
      error: { code: 'plan_limit', details: { article_capacity: invalid } },
    }, { status: 403 }));
    await assert.rejects(unsafe.request('POST', '/projects/1/article_imports', {}), error => {
      assert.equal(error.code, 'plan_limit');
      assert.equal(error.details.article_capacity, undefined);
      assert.doesNotMatch(error.message, /javascript:/);
      return true;
    });
  }
});
