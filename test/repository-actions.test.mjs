import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { localFixture, fixture, context } from './helpers.mjs';
import { createServer } from '../dist/server.js';
import { Session } from '../dist/session.js';
import { Bridge } from '../dist/bridge.js';
import { repositoryAction } from '../dist/repository-actions.js';
import { resolveAction, writerAction, requireExecution } from '../dist/actions.js';
const origin = 'https://app.supportpages.io';
const blocked = (action, code='permission_required') => ({ action, allowed: false, execution: 'hosted', required_scopes: ['read','generate'], next_step: {code, message:'Complete this step.', requested_action:action, missing_scopes:['generate']} });
function contract(overrides={}) {
  return { ...context, repository_connection: { ...context.repository_connection, state: 'connected', writer: { version:1,
    actions: Object.fromEntries(writerAction.options.map(action=>[action, overrides[action] ?? blocked(action)])) } } };
}
test('anonymous creation stays local while hosted actions require sign-in without side effects', async t => {
  const f=await localFixture(t);
  assert.equal((await resolveAction(f.bridge,'create_article')).execution,'local');
  for(const action of ['find_article_gaps','create_video_walkthrough']) {
    const result=await repositoryAction(f.bridge,action);
    assert.equal(result.status,'action_required');
    assert.equal(result.next_step.code,'authentication_required');
    assert.equal(result.next_step.requested_action,action);
  }
  assert.equal(await f.ws.exists('.rtfm/supportpages/active-run.json'),false);
});
test('account without a project validates credentials before offering project selection', async t=>{
  let revoked=false;
  const f=await fixture(t,async()=>revoked ? Response.json({}, {status:401}) : Response.json({projects:[]}));
  assert.equal((await resolveAction(f.bridge,'find_article_gaps')).next_step.code,'project_required');
  revoked=true;
  assert.equal((await resolveAction(f.bridge,'find_article_gaps')).next_step.code,'authentication_required');
});
test('each recovery step preserves the action and never launches local work', async t=>{
  for(const code of ['permission_required','repository_suspended','repository_disconnected','analysing','section_review_required','plan_limit','server_update_required']) {
    const f=await fixture(t,async(url,init)=>{ assert.equal(init.method,'GET');return Response.json(contract({create_article:blocked('create_article',code)})); });
    await f.bridge.bind('1');
    const result=await resolveAction(f.bridge,'create_article');
    assert.equal(result.next_step.code,code);
    await assert.rejects(f.bridge.prepare({title:'Do something',article_type:'how-to'}),{code});
    assert.equal(await f.ws.exists('.rtfm/supportpages/active-run.json'),false);
  }
});
test('older connected and unknown servers return update guidance; local compatibility is explicit', async t=>{
  for(const state of ['connected','disconnected','suspended',undefined,'not_connected']) {
    const f=await fixture(t,async()=>Response.json({...context,repository_connection:state ? {...context.repository_connection,state}:undefined}));
    await f.bridge.bind('1');
    const result=await resolveAction(f.bridge,'create_article');
    assert.equal(result.allowed,state==='not_connected');
    if(state!=='not_connected') assert.equal(result.next_step.code,'server_update_required');
  }
});
test('recovery links cannot redirect to an unrelated origin', async t=>{
  const decision=blocked('find_article_gaps','repository_required');decision.next_step.url='https://untrusted.example/';
  const f=await fixture(t,async()=>Response.json(contract({find_article_gaps:decision})));await f.bridge.bind('1');
  await assert.rejects(repositoryAction(f.bridge,'find_article_gaps'),{code:'invalid_response'});
});
test('an allowed hosted decision cannot be consumed by a local writer', ()=>{
  assert.throws(()=>requireExecution({action:'create_article',allowed:true,execution:'hosted',required_scopes:['generate'],next_step:null},'local'),{code:'hosted_action_required'});
});
test('passive MCP access checks never resume a writer or completion relay',async t=>{
  const f=await localFixture(t);
  t.mock.method(Bridge.prototype,'resumeWriterCompletion',async()=>assert.fail('must remain passive'));
  t.mock.method(globalThis,'fetch',async()=>assert.fail('must not start authentication'));
  const session=new Session({cwd:f.root,origin,dev:false,skillsDir:f.bridge.skillsDir,configDir:path.join(f.root,'config')});
  const server=createServer(session);const client=new Client({name:'access-test',version:'1'});
  const [a,b]=InMemoryTransport.createLinkedPair();await Promise.all([client.connect(a),server.connect(b)]);t.after(()=>client.close());
  for(const action of ['find_article_gaps','create_video_walkthrough']) {
    const result=await client.callTool({name:'supportpages_get_capabilities',arguments:{action}});
    assert.equal(result.structuredContent.result.next_step.code,'authentication_required');
  }
  assert.equal(await f.ws.exists('.rtfm/supportpages/active-run.json'),false);
});
test('passive inspection neither replaces an existing bridge nor suppresses later normal startup', async t => {
  const f = await localFixture(t);
  let resumed = 0, closed = 0;
  t.mock.method(Bridge.prototype, 'resumeWriterCompletion', async () => { resumed++; });
  const session = new Session({ cwd: f.root, origin, dev: false, skillsDir: f.bridge.skillsDir,
    configDir: path.join(f.root, 'config'), token: 'first' });
  t.after(() => session.close());
  const active = await session.bridge();
  t.mock.method(active, 'close', () => { closed++; });
  session.options.token = 'second';
  const passive = await session.bridge(undefined, { resumeCompletion: false });
  assert.notEqual(passive, active);
  assert.equal(closed, 0);
  assert.equal(resumed, 1);
  const normal = await session.bridge();
  assert.notEqual(normal, passive);
  assert.equal(closed, 1);
  assert.equal(resumed, 2);
});

test('Rails contract fixture is accepted without changing any action decision', async()=>{
  const {readFile}=await import('node:fs/promises');
  const {writerCapabilitiesSchema}=await import('../dist/actions.js');
  const raw=JSON.parse(await readFile(new URL('fixtures/contracts/writer-capabilities-v1.json',import.meta.url),'utf8'));
  assert.deepEqual(writerCapabilitiesSchema.parse(raw),raw);
});
