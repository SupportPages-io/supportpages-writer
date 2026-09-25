import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, context } from './helpers.mjs';
import { HostedOperations } from '../dist/hosted-operations.js';
import { writerAction } from '../dist/actions.js';
const allowed=action=>({action,allowed:true,execution:'hosted',required_scopes:['read','generate'],next_step:null});
const metadata={...context,repository_connection:{...context.repository_connection,state:'connected',writer:{version:1,actions:Object.fromEntries(writerAction.options.map(action=>[action,allowed(action)]))}}};
const operation={id:'6',project_id:'1',action:'create_article',execution:'hosted',attempt:1,status:'queued',article_id:'5',result:{},error:null,review_url:'https://app.supportpages.io/projects/example?article=5',created_at:'2026-09-21T12:00:00.000000Z',started_at:null,finished_at:null};

test('hosted create persists request identity before submission and recovers lost responses without a local writer',async t=>{
 const writes=[];let lose=true;
 const f=await fixture(t,async(url,init)=>{
  if(url.endsWith('/context'))return Response.json(metadata);
  if(url.includes('/writer/capabilities'))return Response.json({version:1,decision:allowed('create_article')});
  if(init.method==='POST') {writes.push(init);if(lose){lose=false;throw Error('lost response');}}
  return Response.json(operation);
 });f.bridge.skillsDir='/no-local-article-skills';await f.bridge.bind('1');
 await assert.rejects(f.bridge.createArticle({title:'A useful article'}));
 const restarted=new HostedOperations(f.bridge);
 assert.equal((await restarted.get()).operation_id,'6');
 assert.equal(writes.length,1);
 assert.equal((await f.bridge.createArticle({title:'A useful article'})).operation_id,'6');
 assert.equal(writes[0].headers['Idempotency-Key'],writes[1].headers['Idempotency-Key']);
 assert.deepEqual(JSON.parse(writes[0].body).input,{title:'A useful article',article_type:'how-to',publish:false});
 assert.equal(await f.ws.exists('.rtfm/supportpages/active-run.json'),false);
 assert.equal(await f.ws.exists('.rtfm/project_map.json'),false);
});
test('hosted edits send instructions and article revision without creating replacement content',async t=>{
 let body;
 const f=await fixture(t,async(url,init)=>{
  if(url.endsWith('/context'))return Response.json(metadata);
  if(url.includes('/writer/capabilities'))return Response.json({version:1,decision:allowed('edit_article')});
  body=JSON.parse(init.body);return Response.json({...operation,action:'edit_article'});
 });await f.bridge.bind('1');
 await f.bridge.editArticle({article_id:'5',expected_revision:'a'.repeat(64),instructions:'Clarify the opening.'});
 assert.deepEqual(body.input,{article_id:'5',expected_revision:'a'.repeat(64),instructions:'Clarify the opening.'});
 assert.equal(await f.ws.exists('.rtfm/supportpages/active-run.json'),false);
});
test('blocked repository actions do not submit jobs or invoke local setup',async t=>{
 let writes=0;
 const f=await fixture(t,async(url,init)=>{
  if(init.method==='POST')writes++;
  if(url.endsWith('/context'))return Response.json({...metadata,repository_connection:{...metadata.repository_connection,writer:{version:1,actions:{...metadata.repository_connection.writer.actions,create_article:{...allowed('create_article'),allowed:false,next_step:{code:'repository_suspended',message:'Repair the repository.',requested_action:'create_article'}}}}}});
  throw Error('Unexpected request');
 });await f.bridge.bind('1');
 await assert.rejects(f.bridge.createArticle({title:'Anything'}),{code:'repository_suspended'});
 assert.equal(writes,0);assert.equal(await f.ws.exists('.rtfm/supportpages/active-run.json'),false);
});
test('real Rails operation response supports restart observation',async t=>{
 const {readFile}=await import('node:fs/promises');
 const raw=JSON.parse(await readFile(new URL('fixtures/contracts/writer-operation-v1.json',import.meta.url),'utf8'));
 const meta={...metadata,project:{...metadata.project,id:raw.project_id}};
 const f=await fixture(t,async url=>Response.json(url.endsWith('/context')?meta:raw));
 // The mocked transport uses the actual Rails test server's canonical origin.
 f.bridge.api.origin=new URL(raw.review_url).origin;
 await f.bridge.bind(raw.project_id);
 const result=await f.bridge.hosted.get(raw.id);
 for(const key of ['id','project_id','article_id','attempt','status','result','review_url'])assert.deepEqual(result[key],raw[key]);
});

test('submitting hands back the page to watch instead of waiting or polling',async t=>{
 const polls=[];
 const f=await fixture(t,async(url,init)=>{
  if(url.endsWith('/context'))return Response.json(metadata);
  if(url.includes('/writer/capabilities'))return Response.json({version:1,decision:allowed('create_article')});
  if(url.endsWith('/mcp/settings'))return Response.json({preferences:{prefer_background:false,open_when_ready:false}});
  if(init?.method!=='POST'&&url.includes('/writer_operations/'))polls.push(url);
  return Response.json(operation);
 });f.bridge.skillsDir='/no-local-article-skills';await f.bridge.bind('1');
 const started=Date.now();
 const result=await f.bridge.createArticle({title:'A useful article'});
 // Foreground preference no longer holds the call open.
 assert.ok(Date.now()-started<2000,'submission returns straight away');
 assert.equal(polls.length,0,'submission does not poll the operation');
 assert.equal(result.status,'queued');
 assert.equal(result.review_url,operation.review_url);
 assert.ok(result.instructions.includes(`Show ${operation.review_url} as the place to watch it`));
 assert.match(result.instructions,/Do not poll/);
 assert.match(result.instructions,/only when the user asks how it is going/);
 assert.doesNotMatch(result.instructions,/Observe this operation_id/);
});

test('an operation with nowhere to watch still tells the agent to stop',async t=>{
 const f=await fixture(t,async(url,init)=>{
  if(url.endsWith('/context'))return Response.json(metadata);
  if(url.includes('/writer/capabilities'))return Response.json({version:1,decision:allowed('suggest_sections')});
  return Response.json({...operation,action:'suggest_sections',article_id:null,review_url:null});
 });await f.bridge.bind('1');
 const result=await f.bridge.hosted.submit('suggest_sections',{},{});
 assert.match(result.instructions,/finish your turn/);
 assert.match(result.instructions,/Do not poll/);
});
