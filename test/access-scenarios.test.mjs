import test from 'node:test';
import assert from 'node:assert/strict';
import { article } from './helpers.mjs';
import { scenarios, hostedActions, reference, scenarioFixture, mcp, result, blocked } from './scenario-helpers.mjs';

for (const scenario of scenarios) {
  test(`${scenario}: MCP creation uses the permitted execution location`, async t => {
    const f = await scenarioFixture(t, scenario), call = await mcp(t, f.bridge);
    const value = result(await call('create_article', { title: 'Invite', prefer_background: true }));
    if (scenario === 'connected') {
      assert.equal(value.execution, 'hosted');
      assert.equal(value.status, 'queued');
      assert.equal(await f.ws.exists(`${f.bridge.stateRoot}/active-run.json`), false);
      assert.equal(await f.ws.exists('.rtfm/project_map.json'), false);
      const writes = f.calls.filter(c => c.method === 'POST');
      assert.equal(writes.length, 1);
      assert.equal(writes[0].body.input.publish, false);
    } else {
      assert.equal(value.status, 'prepared');
      assert.ok(value.task_brief);
      assert.equal(f.calls.filter(c => c.method !== 'GET').length, 0);
      assert.equal(value.local === true, scenario === 'anonymous');
    }
  });
  for (const action of hostedActions) {
    test(`${scenario}: MCP ${action} submits remotely or returns the precise prerequisite`, async t => {
      const f = await scenarioFixture(t, scenario), call = await mcp(t, f.bridge);
      const response = await call(action, action === 'create_video_walkthrough' ? reference : {});
      if (scenario === 'connected') {
        const value = result(response);
        assert.equal(value.action, action);
        assert.equal(value.status, 'queued');
        assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
      } else {
        blocked(response, scenario === 'anonymous' ? 'authentication_required' : 'repository_required');
        assert.equal(response.structuredContent.result.next_step.requested_action, action);
        assert.equal(f.calls.filter(c => c.method !== 'GET').length, 0);
      }
      assert.equal(await f.ws.exists(`${f.bridge.stateRoot}/active-run.json`), false);
    });
  }
  test(`${scenario}: MCP remote inventory, draft mutations and review decisions respect access`, async t => {
    const f = await scenarioFixture(t, scenario), call = await mcp(t, f.bridge);
    for (const tool of ['list_articles', 'list_walkthroughs', 'list_sections', 'list_recommendations']) {
      const response = await call(tool);
      if (scenario === 'anonymous' && tool !== 'list_articles') blocked(response, 'authentication_required');
      else {
        const value = result(response);
        if (scenario === 'anonymous') { assert.equal(value.source, 'local'); assert.deepEqual(value.articles, []); }
      }
    }
    let revision = reference.expected_revision;
    for (const tool of ['update_article', 'publish_article', 'unpublish_article', 'delete_article']) {
      const response = await call(tool, { article_id: '5', expected_revision: revision, ...(tool === 'update_article' ? { structured_content: article } : {}) });
      if (scenario === 'anonymous') blocked(response, 'authentication_required');
      else {
        const value = result(response);
        assert.equal(value.id, '5');
        revision = value.revision ?? revision;
        if (tool === 'publish_article') assert.equal(value.status, 'published');
        if (tool === 'unpublish_article') assert.equal(value.status, 'draft');
      }
    }
    for (const [kind, id] of [['sections', '2'], ['recommendations', '3']]) {
      for (const decision of ['accept', 'reject']) {
        const response = await call(`review_${kind}`, { id, decision });
        if (scenario === 'connected') assert.equal(result(response).status, decision === 'accept' ? 'accepted' : 'rejected');
        else blocked(response, scenario === 'anonymous' ? 'authentication_required' : 'repository_required');
      }
    }
    assert.equal(f.calls.some(c => c.url.endsWith('/writer_operations')), false);
    assert.equal(await f.ws.exists(`${f.bridge.stateRoot}/active-run.json`), false);
  });
  test(`${scenario}: MCP AI editing uses the permitted execution location`, async t => {
    const f = await scenarioFixture(t, scenario), call = await mcp(t, f.bridge);
    const response = await call('edit_article', { ...reference, instructions: 'Clarify the opening.' });
    if (scenario === 'anonymous') blocked(response, 'authentication_required');
    else if (scenario === 'connected') {
      assert.equal(result(response).status, 'queued');
      assert.deepEqual(f.calls.find(c => c.method === 'POST').body.input, { ...reference, instructions: 'Clarify the opening.' });
    } else {
      const value = result(response);
      assert.equal(value.status, 'local_edit_required');
      assert.equal(value.next_tool, 'supportpages_update_article');
      assert.equal(value.expected_revision, reference.expected_revision);
      assert.deepEqual(value.article.content, article);
      assert.equal(f.calls.filter(c => c.method !== 'GET').length, 0);
      const edited = structuredClone(value.article.content);
      edited.blocks[0].content = 'Clearer opening.';
      const saved = result(await call('update_article', { ...reference, structured_content: edited }));
      assert.equal(saved.status, 'draft');
      assert.deepEqual(saved.content.blocks[1], article.blocks[1], 'existing image reference is preserved');
      assert.equal(f.calls.filter(c => c.method !== 'GET').length, 1);
    }
    assert.equal(await f.ws.exists(`${f.bridge.stateRoot}/active-run.json`), false);
  });
}

test('account-only MCP editing rejects stale revisions before editing and during save', async t => {
  const f = await scenarioFixture(t, 'account_only'), call = await mcp(t, f.bridge);
  f.state.article.revision = 'c'.repeat(64);
  blocked(await call('edit_article', { ...reference, instructions: 'Clarify.' }), 'revision_conflict');
  assert.equal(f.calls.filter(c => c.method !== 'GET').length, 0);
  const current = result(await call('edit_article', { ...reference, expected_revision: f.state.article.revision, instructions: 'Clarify.' }));
  f.state.article.revision = 'd'.repeat(64);
  blocked(await call('update_article', { ...reference, expected_revision: current.expected_revision, structured_content: article }), 'revision_conflict');
  assert.equal(f.calls.filter(c => c.method !== 'GET').length, 1, 'conflicting save is not retried');
  assert.deepEqual(f.state.article.content, article);
});

test('account-only published edits require a repository while unpublication remains available', async t => {
  const f = await scenarioFixture(t, 'account_only'), call = await mcp(t, f.bridge);
  f.state.article.status = 'published';
  blocked(await call('edit_article', { ...reference, instructions: 'Clarify.' }), 'repository_required');
  blocked(await call('update_article', { ...reference, structured_content: article }), 'repository_required');
  assert.equal(f.calls.filter(c => c.method !== 'GET').length, 0);
  assert.equal(result(await call('unpublish_article', reference)).status, 'draft');
});

for (const code of ['repository_suspended', 'repository_disconnected', 'analysing', 'permission_required', 'plan_limit']) {
  test(`MCP hosted creation blocked by ${code} never falls back locally`, async t => {
    const f = await scenarioFixture(t, 'connected'), call = await mcp(t, f.bridge);
    const decision = f.metadata.repository_connection.writer.actions.create_article;
    decision.allowed = false;
    decision.next_step = { code, message: 'Complete the prerequisite.', requested_action: 'create_article' };
    blocked(await call('create_article', { title: 'Invite' }), code);
    assert.equal(f.calls.filter(c => c.method !== 'GET').length, 0);
    assert.equal(await f.ws.exists(`${f.bridge.stateRoot}/active-run.json`), false);
  });
}

for (const scenario of scenarios) {
  test(`${scenario}: MCP capabilities cover every supported action without side effects`, async t => {
    const { writerAction } = await import('../dist/actions.js');
    const f = await scenarioFixture(t, scenario), call = await mcp(t, f.bridge);
    for (const action of writerAction.options) {
      const value = result(await call('get_capabilities', { action }));
      const allowed = scenario === 'connected' || scenario === 'anonymous' && action === 'create_article' ||
        scenario === 'account_only' && ![...hostedActions, 'review_sections', 'review_recommendations'].includes(action);
      assert.equal(value.allowed, allowed, action);
      if (!allowed) {
        assert.equal(value.next_step.code, scenario === 'anonymous' ? 'authentication_required' : 'repository_required', action);
        assert.equal(value.next_step.requested_action, action);
      }
    }
    assert.equal(f.calls.filter(c => c.method !== 'GET').length, 0);
    assert.equal(await f.ws.exists(`${f.bridge.stateRoot}/active-run.json`), false);
  });
}

test('credentials rejected by the API require sign-in without local fallback or submission', async t => {
  const f = await scenarioFixture(t, 'connected'), call = await mcp(t, f.bridge);
  f.state.failure = 401;
  blocked(await call('create_article', { title: 'Invite' }), 'authentication_required');
  blocked(await call('edit_article', { ...reference, instructions: 'Clarify.' }), 'authentication_required');
  blocked(await call('create_video_walkthrough', reference), 'authentication_required');
  assert.equal(f.calls.filter(c => c.method !== 'GET').length, 0);
  assert.equal(await f.ws.exists(`${f.bridge.stateRoot}/active-run.json`), false);
});
