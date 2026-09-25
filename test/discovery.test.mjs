import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,context} from './helpers.mjs';
import {writerAction} from '../dist/actions.js';
const metadata={...context,repository_connection:{...context.repository_connection,state:'connected',writer:{version:1,actions:Object.fromEntries(writerAction.options.map(action=>[action,{action,allowed:true,execution:['read_articles','review_sections','review_recommendations'].includes(action)?'remote':'hosted',required_scopes:['read'],next_step:null}]))}}};
const operation={id:'6',project_id:'1',action:'find_article_gaps',execution:'hosted',attempt:1,status:'queued',article_id:null,result:{},error:null,review_url:null,created_at:'2026-09-21T12:00:00Z',started_at:null,finished_at:null};
test('discovery submits durable hosted jobs without local analysis or auto-generation input',async t=>{
 const writes=[];
 const f=await fixture(t,async(url,init)=>{
  if(url.endsWith('/context'))return Response.json(metadata);
  const body=JSON.parse(init.body);writes.push(body);
  return Response.json({...operation,action:body.action_name});
 });await f.bridge.bind('1');
 for(const action of ['suggest_sections','recommend_articles','find_article_gaps'])await f.bridge.hosted.submit(action,{});
 assert.equal(writes.length,3);assert.ok(writes.every(body=>JSON.stringify(body.input)==='{}'));
 assert.equal(await f.ws.exists('.rtfm/supportpages/active-run.json'),false);
});
test('review decisions mutate only selected IDs and generation uses accepted recommendation references',async t=>{
 const requests=[];
 const section={id:'2',name:'Start',slug:'start',description:null,justification:null,status:'accepted',visible:true};
 const f=await fixture(t,async(url,init)=>{
  if(url.endsWith('/context'))return Response.json(metadata);
  requests.push({url,method:init.method,body:JSON.parse(init.body)});
  return Response.json(init.method==='PATCH'?section:{...operation,article_id:'5',action:'create_article'});
 });await f.bridge.bind('1');
 await f.bridge.reviewSuggestion('sections','2','accept');
 assert.equal(requests.length,1);assert.equal(requests[0].method,'PATCH');
 await f.bridge.createArticle({recommendation_id:'7',article_type:'how-to'});
 assert.deepEqual(requests[1].body.input,{recommendation_id:'7',publish:false});
});
test('real Rails review lists retain persistent IDs, decisions and pagination',async t=>{
 const {readFile}=await import('node:fs/promises');
 for(const kind of ['sections','recommendations']) {
  const raw=JSON.parse(await readFile(new URL(`fixtures/contracts/writer-${kind}-v1.json`,import.meta.url),'utf8'));
  const f=await fixture(t,async url=>Response.json(url.endsWith('/context')?metadata:raw));await f.bridge.bind('1');
  assert.deepEqual(await f.bridge.listSuggestions(kind),raw);
 }
});
