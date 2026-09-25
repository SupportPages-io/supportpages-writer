import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../dist/server.js';
import { ApiClient } from '../dist/api.js';
import { writerAction } from '../dist/actions.js';
import { fixture, seedAnalysis, context, remote, article } from './helpers.mjs';

export const scenarios = ['connected', 'account_only', 'anonymous'];
export const hostedActions = ['find_article_gaps', 'suggest_sections', 'recommend_articles', 'create_video_walkthrough'];
export const reference = { article_id: '5', expected_revision: remote.revision };
export async function mcp(t, bridge) {
  const client = new Client({ name: 'scenario-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), createServer(bridge).connect(b)]);
  t.after(() => client.close());
  return (name, args = {}) => client.callTool({ name: `supportpages_${name}`, arguments: args });
}
export function result(response) {
  assert.notEqual(response.isError, true, JSON.stringify(response.structuredContent));
  return response.structuredContent.result;
}
export function blocked(response, code) {
  const payload = response.structuredContent;
  assert.equal(payload.error?.code ?? payload.result?.next_step?.code, code, JSON.stringify(payload));
}
export async function scenarioFixture(t, scenario) {
  const calls = [];
  const state = { article: { ...remote, title: article.title, content: structuredClone(article), content_format: 'structured' }, failure: undefined };
  const decisions = Object.fromEntries(writerAction.options.map(action => {
    const hosted = hostedActions.includes(action) || scenario === 'connected' && ['create_article', 'edit_article'].includes(action);
    const denied = scenario !== 'connected' && (hostedActions.includes(action) || ['review_sections', 'review_recommendations'].includes(action));
    return [action, { action, allowed: !denied, execution: hosted ? 'hosted' : ['create_article', 'edit_article'].includes(action) ? 'local' : 'remote', required_scopes: ['read'],
      next_step: denied ? { code: 'repository_required', message: 'Connect a repository.', requested_action: action } : null }];
  }));
  const metadata = { ...context, walkthrough_sync: true, repository_connection: { ...context.repository_connection,
    state: scenario === 'connected' ? 'connected' : 'not_connected', writer: { version: 1, actions: decisions } } };
  const section = { id: '2', name: 'Start', slug: 'start', description: null, justification: null, status: 'pending', visible: true };
  const recommendation = { id: '3', section_id: '2', title: 'Invite', description: null, justification: null, article_type: 'how-to', status: 'pending', article_id: null };
  const f = await fixture(t, async (url, init) => {
    calls.push({ url, method: init.method, body: init.body && JSON.parse(init.body) });
    if (state.failure) return Response.json({}, { status: state.failure });
    const route = new URL(url);
    if (url.endsWith('/context')) return Response.json(metadata);
    if (url.endsWith('/projects')) return Response.json({ projects: [context.project] });
    if (url.includes('/writer/capabilities')) {
      const decision = { ...decisions[route.searchParams.get('action_name')] };
      if (scenario === 'account_only' && state.article.status === 'published' && ['update_article', 'edit_article'].includes(decision.action)) {
        decision.allowed = false;
        decision.next_step = { code: 'repository_required', message: 'Connect a repository.', requested_action: decision.action };
      }
      return Response.json({ version: 1, decision });
    }
    if (url.endsWith('/writer_operations') && init.method === 'POST') return Response.json({ id: '6', project_id: '1', action: JSON.parse(init.body).action_name,
      execution: 'hosted', attempt: 1, status: 'queued', article_id: '5', walkthrough_id: null, result: {}, error: null, review_url: null,
      created_at: '2026-09-21T12:00:00Z', started_at: null, finished_at: null });
    for (const [kind, item] of [['sections', section], ['recommendations', recommendation]]) {
      if (url.endsWith(`/writer/${kind}`)) return Response.json({ kind, items: [item], next_cursor: null });
      if (url.endsWith(`/writer/${kind}/${item.id}`)) return Response.json({ ...item, status: JSON.parse(init.body).decision === 'accept' ? 'accepted' : 'rejected' });
    }
    if (url.endsWith('/walkthroughs')) return Response.json({ project_id: '1', through_id: '0', next_cursor: null, walkthroughs: [] });
    if (url.endsWith('/articles')) return Response.json({ articles: [state.article], next_cursor: null });
    if (/\/articles\/5(?:\/(?:unpublish|publish))?$/.test(route.pathname)) {
      const body = init.body && JSON.parse(init.body);
      if (body && body.expected_revision !== state.article.revision) return Response.json({ error: { code: 'revision_conflict' } }, { status: 409 });
      if (init.method === 'DELETE') return Response.json({ id: '5', deleted_at: '2026-09-21T12:00:00Z' });
      if (init.method === 'PATCH') state.article = { ...state.article, content: body.structured_content, revision: 'b'.repeat(64) };
      if (url.endsWith('/publish')) state.article.status = 'published';
      if (url.endsWith('/unpublish')) state.article.status = 'draft';
      return Response.json(state.article);
    }
    assert.fail(`Unexpected ${init.method} ${url}`);
  });
  if (scenario === 'anonymous') {
    f.bridge.api = new ApiClient('https://app.supportpages.io', undefined, async () => assert.fail('Anonymous action must not access the network'));
    await f.bridge.saveLocal({ version: 1, export_dir: 'output/articles' });
  } else await f.bridge.bind('1');
  if (scenario !== 'connected') await seedAnalysis(f.ws);
  else f.bridge.skillsDir = '/no-local-skills';
  return { ...f, calls, state, metadata };
}
