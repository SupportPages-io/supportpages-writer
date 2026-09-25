import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Session } from '../dist/session.js';
import { createServer } from '../dist/server.js';
import { writerAction } from '../dist/actions.js';
import { scenarios, scenarioFixture, mcp, result } from './scenario-helpers.mjs';
import { fixture } from './helpers.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// A coding agent never sends the user to a terminal: every recovery names an
// MCP tool, and signing in is offered as a question, not started on its own.
const terminal = /supportpages (login|publish|init|configure|setup|sync)\b|in (the|a) terminal/;
const offer = /sign in or create a free SupportPages\.io account/;

test('anonymous hosted requests ask about an account and point at supportpages_init, never the CLI', async t => {
  const f = await scenarioFixture(t, 'anonymous'), call = await mcp(t, f.bridge);
  for (const [tool, args] of [['list_articles', { source: 'hosted' }], ['list_walkthroughs', {}], ['get_article', { article_id: '5' }], ['publish_article', { article_id: '5', expected_revision: 'a'.repeat(64) }]]) {
    const response = await call(tool, args);
    assert.equal(response.isError, true, tool);
    const error = response.structuredContent.error;
    // Reads of the linked help centre fail on the missing sign-in; article
    // tools fail first on the missing help centre. Both recover through a tool.
    const expected = { authentication_required: 'supportpages_init', missing_credentials: 'supportpages_init', local_workspace: 'supportpages_init' };
    assert.ok(expected[error.code], `${tool}: ${error.code}`);
    assert.equal(error.next_tool, expected[error.code], tool);
    assert.match(error.message, offer, tool);
    assert.match(error.message, /host_local=true \(signup=true for a new account\)/, tool);
    assert.doesNotMatch(error.message, terminal, tool);
    assert.deepEqual(JSON.parse(response.content[0].text).error, JSON.parse(JSON.stringify(error)), 'text and structured content agree');
  }
  const capability = result(await call('get_capabilities', { action: 'find_article_gaps' }));
  assert.equal(capability.allowed, false);
  assert.equal(capability.next_step.code, 'authentication_required');
  assert.equal(capability.next_step.next_tool, 'supportpages_init');
  assert.match(capability.next_step.message, offer);
  assert.doesNotMatch(capability.next_step.message, terminal);
  assert.equal(f.calls.filter(c => c.method !== 'GET').length, 0, 'nothing was submitted or signed in');
});

test('account-only recovery names the permission tool and keeps the missing scopes', async t => {
  const f = await scenarioFixture(t, 'account_only'), call = await mcp(t, f.bridge);
  const blocked = result(await call('get_capabilities', { action: 'suggest_sections' }));
  assert.equal(blocked.next_step.code, 'repository_required');
  assert.equal(blocked.next_step.next_tool, undefined, 'repository setup keeps the server’s own message and URL');
  assert.doesNotMatch(blocked.next_step.message, terminal);
  const decision = f.metadata.repository_connection.writer.actions.update_article;
  decision.allowed = false;
  decision.next_step = { code: 'permission_required', message: 'Approve the missing device permissions, then retry this action.', requested_action: 'update_article', missing_scopes: ['manage'] };
  const response = await call('update_article', { article_id: '5', expected_revision: 'a'.repeat(64), body: 'Hello' });
  assert.equal(response.isError, true);
  const error = response.structuredContent.error;
  assert.equal(error.code, 'permission_required');
  assert.equal(error.next_tool, 'supportpages_request_permissions');
  assert.doesNotMatch(error.message, terminal);
  assert.match(error.details.writer_action.next_step.message, /Missing scopes: manage\./);
  assert.equal(error.details.writer_action.next_step.next_tool, 'supportpages_request_permissions');
});

for (const scenario of scenarios) {
  test(`${scenario}: no MCP response mentions a terminal command`, async t => {
    const f = await scenarioFixture(t, scenario), call = await mcp(t, f.bridge);
    for (const [tool, args] of [['status', {}], ['list_articles', {}], ['get_capabilities', { action: 'create_article' }], ['create_article', { title: 'Invite', prefer_background: true }], ['sync', {}], ['upload_draft', { slug: 'invite' }]]) {
      const response = await call(tool, args);
      const text = JSON.stringify(response.structuredContent).replace(/supportpages analyse[^"]*/g, '');
      assert.doesNotMatch(text, terminal, `${tool} in ${scenario}`);
    }
  });
}

const origin = 'https://app.lvh.me:3443';
const startResponse = { pairing_id: 'a'.repeat(64), pairing_secret: 'c'.repeat(64), verification_uri: `${origin}/settings/mcp/connect/${'a'.repeat(64)}`,
  user_code: 'ABCD-EFGH', expires_at: new Date(Date.now() + 600_000).toISOString(), interval: 3 };

test('init and publish with signup land browser approval on account creation', async t => {
  for (const [tool, args] of [['supportpages_init', { signup: true }], ['supportpages_setup_hosted', { action: 'find_article_gaps', signup: true }]]) {
    const f = await fixture(t);
    const session = new Session({ cwd: f.root, origin, dev: true, skillsDir: path.join(f.root, 'skills'), configDir: path.join(f.root, 'private-user-config'),
      pairingRuntime: { fetcher: async () => Response.json(startResponse), now: Date.now, sleep: () => new Promise(() => {}) } });
    t.after(() => session.close());
    const client = new Client({ name: 'claude-code', version: '1.0.0' });
    const server = createServer(session);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a); await client.connect(b); t.after(() => client.close());
    const response = await client.callTool({ name: tool, arguments: args });
    const value = response.structuredContent.result;
    assert.equal(value.status, 'authentication_required', tool);
    const url = new URL(value.verification_uri);
    assert.equal(url.searchParams.get('signup'), '1', tool);
    assert.equal(url.origin + url.pathname, startResponse.verification_uri, tool);
    assert.equal(value.user_code, 'ABCD-EFGH');
    assert.doesNotMatch(JSON.stringify(value), terminal, tool);
  }
  // Without the flag the approval link is untouched.
  const f = await fixture(t);
  const session = new Session({ cwd: f.root, origin, dev: true, skillsDir: path.join(f.root, 'skills'), configDir: path.join(f.root, 'private-user-config'),
    pairingRuntime: { fetcher: async () => Response.json(startResponse), now: Date.now, sleep: () => new Promise(() => {}) } });
  t.after(() => session.close());
  assert.equal((await session.init({})).verification_uri, startResponse.verification_uri);
});

// The transcript that motivated this: a local folder, the user says "sign in",
// and the agent must be able to finish the job — sign in, link, then list.
async function localSession(t, { elicitation = { url: {} }, onForm, onUrl = () => 'accept', browserOpens = true, openBrowserApproves = true, callBudgetMs = 50_000 } = {}) {
  const { localFixture, context, remote } = await import('./helpers.mjs');
  const { ElicitRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
  const production = 'https://app.supportpages.io', token = 'sp_local_' + 'b'.repeat(64);
  const f = await localFixture(t);
  let approved = false, wake;
  const pairings = [];
  const runtime = { now: Date.now, sleep: async () => { if (!approved) await new Promise(resolve => { wake = resolve; }); }, fetcher: async (url, init) => {
    if (url.endsWith('/pairings')) { pairings.push(JSON.parse(init.body)); return Response.json({ pairing_id: 'a'.repeat(64), pairing_secret: 'c'.repeat(64), verification_uri: `${production}/settings/mcp/connect/${'a'.repeat(64)}`, user_code: 'ABCD-EFGH', expires_at: new Date(Date.now() + 600_000).toISOString(), interval: 3 }); }
    if (url.endsWith('/poll')) return Response.json({ status: 'approved' });
    if (url.endsWith('/exchange')) return Response.json({ status: 'authorized', api_origin: production, account: { id: '10', email: 'alice@example.com' }, token, scopes: ['read', 'import', 'projects:create'], token_expires_at: new Date(Date.now() + 86400_000).toISOString() });
    return Response.json({ status: 'completed' });
  } };
  const listed = [], created = [];
  const actions = Object.fromEntries(writerAction.options.map(action => [action, { action, allowed: true, execution: ['create_article', 'edit_article'].includes(action) ? 'local' : 'remote', required_scopes: ['read'], next_step: null }]));
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(init.headers.Authorization, `Bearer ${token}`);
    if (url.endsWith('/projects') && init.method === 'POST') { created.push(JSON.parse(init.body)); return Response.json({ ...context.project, id: '9', name: created.at(-1).name }); }
    if (url.endsWith('/projects')) return Response.json({ projects: [{ ...context.project, help_centre_url: 'https://example.supportpages.io' }, { id: '2', name: 'Other' }] });
    if (url.endsWith('/context')) return Response.json({ ...context, walkthrough_sync: true, project: { ...context.project, id: url.match(/projects\/(\d+)/)[1] }, repository_connection: { ...context.repository_connection, state: 'not_connected', writer: { version: 1, actions } } });
    if (url.endsWith('/mcp/settings')) return Response.json({ preferences: { prefer_background: true, open_when_ready: false } });
    if (url.endsWith('/articles')) { listed.push(url); return Response.json({ articles: [{ ...remote, title: 'Hosted one' }], next_cursor: null }); }
    if (url.endsWith('/articles/5')) return Response.json({ ...remote, title: 'Hosted one', content: {}, content_format: 'structured' });
    if (url.endsWith('/walkthroughs')) return Response.json({ walkthroughs: [], next_cursor: null, project_id: '1', through_id: '0' });
    throw Error(`Unexpected request ${init.method} ${url}`);
  });
  const session = new Session({ cwd: f.root, origin: production, dev: false, skillsDir: f.bridge.skillsDir, configDir: path.join(f.root, 'config'), pairingRuntime: runtime, callBudgetMs });
  const opened = [];
  session.openBrowser = async url => { opened.push(url); if (openBrowserApproves) { approved = true; wake?.(); } return browserOpens; };
  const server = createServer(session);
  const client = new Client({ name: 'claude-code', version: '1.0.0' }, { capabilities: { elicitation } });
  const dialogs = [];
  client.setRequestHandler(ElicitRequestSchema, async request => {
    if (request.params.mode === 'url') { dialogs.push({ url: request.params.url }); const action = onUrl(request.params); if (action === 'accept') { approved = true; wake?.(); } return { action }; }
    dialogs.push({ form: request.params.requestedSchema, message: request.params.message });
    return onForm(request.params, dialogs.filter(d => d.form).length);
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  t.after(async () => { session.close(); await client.close(); });
  const call = async (name, args = {}) => (await client.callTool({ name: `supportpages_${name}`, arguments: args })).structuredContent;
  return { f, session, call, dialogs, listed, created, pairings, token, opened };
}

test('init with host_local signs a local folder in, links the chosen help centre and unlocks hosted reads', async t => {
  const { f, session, call, listed } = await localSession(t);
  // Unasked, a local folder never starts sign-in.
  assert.equal((await call('init')).result.status, 'local');
  assert.equal(await session.bridge().then(bridge => bridge.api.configured()), false);
  // The user said yes: sign in completes through elicitation and the help centre choice follows.
  const signedIn = (await call('init', { host_local: true })).result;
  assert.equal(signedIn.status, 'project_required');
  assert.deepEqual((signedIn.projects.projects ?? signedIn.projects).map(project => project.id), ['1', '2']);
  assert.doesNotMatch(JSON.stringify(signedIn), terminal);
  assert.equal(await f.ws.exists('.rtfm/supportpages/binding.json'), false, 'no help centre is chosen for the user');
  // Linking makes the folder hosted; the saved files stay where they are.
  const linked = (await call('init', { host_local: true, project_id: '1' })).result;
  assert.equal(linked.status, 'ready'); assert.equal(linked.project_id, '1');
  assert.equal(await (await session.bridge()).destination(), 'hosted');
  assert.equal(await f.ws.exists('.rtfm/supportpages/local.json'), true);
  const hosted = (await call('list_articles')).result;
  assert.equal(hosted.source, undefined); assert.equal(hosted.articles[0].title, 'Hosted one');
  assert.equal(listed.length, 1);
});

test('with a client dialog the server asks the account question itself, signs in, picks the help centre and answers the original request', async t => {
  const { f, session, call, dialogs, listed, pairings } = await localSession(t, { elicitation: { form: {}, url: {} },
    onForm: (params, index) => ({ action: 'accept', content: index === 1 ? { account: 'sign_in' } : { project: '1' } }) });
  const response = await call('list_articles', { source: 'hosted' });
  assert.equal(response.error, undefined, JSON.stringify(response.error));
  assert.equal(response.result.articles[0].title, 'Hosted one');
  assert.equal(listed.length, 1);
  // Three dialogs, in order: account question, browser approval, help centre.
  assert.equal(dialogs.length, 3);
  assert.match(dialogs[0].message, /not signed in to SupportPages\.io/);
  const account = dialogs[0].form.properties.account;
  assert.deepEqual(account.enum, ['sign_in', 'create_account', 'not_now']);
  assert.equal(account.enumNames.length, 3);
  assert.deepEqual(dialogs[0].form.required, ['account']);
  assert.match(dialogs[1].url, /settings\/mcp\/connect/);
  assert.equal(new URL(dialogs[1].url).searchParams.get('signup'), null);
  assert.deepEqual(dialogs[2].form.properties.project.enum, ['1', '2', 'new']);
  assert.match(dialogs[2].form.properties.project.enumNames[0], /example\.supportpages\.io/);
  assert.equal(pairings.length, 1);
  assert.equal(await (await session.bridge()).destination(), 'hosted');
  assert.equal(await f.ws.exists('.rtfm/supportpages/local.json'), true, 'saved files stay in place');
  // Signed in and linked: no further dialogs.
  assert.equal((await call('list_walkthroughs')).error, undefined);
  assert.equal(dialogs.length, 3);
});

test('choosing a new account lands approval on registration and creates the help centre from a dialog', async t => {
  const { call, dialogs, created, session } = await localSession(t, { elicitation: { form: {}, url: {} },
    onForm: (params, index) => ({ action: 'accept', content: index === 1 ? { account: 'create_account' } : index === 2 ? { project: 'new' } : { name: 'Acme', subdomain: 'acme' } }) });
  const response = await call('get_article', { article_id: '5' });
  assert.equal(response.error?.code, undefined, JSON.stringify(response.error));
  assert.equal(new URL(dialogs[1].url).searchParams.get('signup'), '1');
  assert.deepEqual(created, [{ name: 'Acme', subdomain: 'acme' }]);
  assert.equal(dialogs[3].form.properties.subdomain.default, path.basename(session.options.cwd).toLowerCase(), 'address suggested from the folder name');
  assert.equal(dialogs[3].form.properties.name.default, path.basename(session.options.cwd));
  assert.equal((await (await session.bridge()).binding()).project_id, '9');
});

test('declining keeps the folder local and is not asked again in the session', async t => {
  const { call, dialogs, pairings, session } = await localSession(t, { elicitation: { form: {}, url: {} }, onForm: () => ({ action: 'accept', content: { account: 'not_now' } }) });
  const first = await call('list_articles', { source: 'hosted' });
  assert.equal(first.error.code, 'authentication_required');
  assert.match(first.error.message, /The user chose not to sign in\. Continue without the hosted help centre and do not ask again/);
  assert.deepEqual(first.error.details.account_offer, { status: 'declined', asked: true });
  assert.doesNotMatch(first.error.message, terminal);
  const second = await call('list_walkthroughs');
  assert.match(second.error.message, /earlier in this session/);
  assert.equal(dialogs.length, 1, 'asked once');
  assert.equal(pairings.length, 0, 'no sign-in was started');
  assert.equal(await (await session.bridge()).destination(), 'local');
  // Cancelling the dialog counts as declining too.
  const { call: cancelled, dialogs: cancelledDialogs } = await localSession(t, { elicitation: { form: {}, url: {} }, onForm: () => ({ action: 'cancel' }) });
  assert.match((await cancelled('list_articles', { source: 'hosted' })).error.message, /chose not to sign in/);
  assert.equal(cancelledDialogs.length, 1);
});

test('without a client dialog the agent is told to ask, as before', async t => {
  const { call, dialogs, pairings } = await localSession(t, { elicitation: { url: {} } });
  const response = await call('list_articles', { source: 'hosted' });
  assert.equal(response.error.code, 'authentication_required');
  assert.equal(response.error.next_tool, 'supportpages_init');
  assert.match(response.error.message, offer);
  assert.equal(dialogs.length, 0); assert.equal(pairings.length, 0);
});

test('publish asks through the dialog too, and an explicit request overrides an earlier "not now"', async t => {
  let answer = 'not_now';
  const { f, call, dialogs, session } = await localSession(t, { elicitation: { form: {}, url: {} },
    onForm: (params, index) => ({ action: 'accept', content: params.requestedSchema.properties.account ? { account: answer } : { project: '1' } }) });
  const { article } = await import('./helpers.mjs');
  const prepared = await f.bridge.prepare({ title: 'Invite', article_type: 'how-to' });
  await f.output({ ...article, title: 'Invite' });
  await f.bridge.complete({ run_id: prepared.run_id, completed: true });
  // An unprompted offer declined earlier in the session…
  assert.match((await call('list_articles', { source: 'hosted' })).error.message, /chose not to sign in/);
  // …does not silence the user's own request to host the saved articles.
  answer = 'sign_in';
  const hosted = await call('publish', { slugs: [] });
  assert.equal(hosted.error, undefined, JSON.stringify(hosted.error));
  assert.equal(await (await session.bridge()).destination(), 'hosted');
  assert.equal(dialogs.filter(d => d.form?.properties.account).length, 2, 'asked again because the user asked to host');
  assert.equal(dialogs.filter(d => d.url).length, 1);
});

// Claude Code declares `elicitation: {}`, which the SDK reads as form-only: the
// server opens the approval page itself and finishes the flow in one call.
test('a form-only client gets the browser opened for it and the request answered in the same call', async t => {
  const { call, dialogs, opened, listed, session } = await localSession(t, { elicitation: {},
    onForm: (params, index) => ({ action: 'accept', content: index === 1 ? { account: 'sign_in' } : { project: '1' } }) });
  const response = await call('list_articles', { source: 'hosted' });
  assert.equal(response.error, undefined, JSON.stringify(response.error));
  assert.equal(response.result.articles[0].title, 'Hosted one');
  assert.equal(opened.length, 1, 'the approval page is opened without being asked');
  assert.match(opened[0], /settings\/mcp\/connect/);
  assert.equal(dialogs.filter(d => d.url).length, 0, 'no URL elicitation: the client does not support it');
  assert.equal(dialogs.filter(d => d.form).length, 2, 'account question, then help centre');
  assert.equal(listed.length, 1);
  assert.equal(await (await session.bridge()).destination(), 'hosted');
});

test('an unapproved or unopenable page reports accurately and leaves the pairing to be picked up', async t => {
  // Approval never lands within the wait.
  const slow = await localSession(t, { elicitation: {}, openBrowserApproves: false, callBudgetMs: 1,
    onForm: () => ({ action: 'accept', content: { account: 'sign_in' } }) });
  const waiting = await slow.call('list_articles', { source: 'hosted' });
  assert.equal(waiting.error.code, 'authentication_required');
  assert.match(waiting.error.message, /was opened in their browser/);
  assert.match(waiting.error.message, /call supportpages_status/);
  assert.equal(waiting.error.details.account_offer.browser_opened, true);
  assert.equal(waiting.error.details.account_offer.user_code, 'ABCD-EFGH');
  assert.equal(slow.opened.length, 1);
  assert.doesNotMatch(waiting.error.message, terminal);
  // The browser cannot be opened at all: say so and hand over the link.
  const blind = await localSession(t, { elicitation: {}, browserOpens: false, openBrowserApproves: false, callBudgetMs: 1,
    onForm: () => ({ action: 'accept', content: { account: 'sign_in' } }) });
  const manual = await blind.call('list_articles', { source: 'hosted' });
  assert.match(manual.error.message, /could not be opened automatically: say so, show browser_url/);
  assert.equal(manual.error.details.account_offer.browser_opened, false);
  assert.match(manual.error.details.account_offer.browser_url, /settings\/mcp\/connect/);
});
