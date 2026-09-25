import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,context,remote} from './helpers.mjs';
import {writerAction} from '../dist/actions.js';
const decision={action:'create_video_walkthrough',allowed:true,execution:'hosted',required_scopes:['read','generate'],next_step:null};
const metadata={...context,repository_connection:{...context.repository_connection,state:'connected',writer:{version:1,actions:Object.fromEntries(writerAction.options.map(action=>[action,{...decision,action}]))}}};
const operation={id:'6',project_id:'1',action:'create_video_walkthrough',execution:'hosted',attempt:1,status:'queued',article_id:'5',walkthrough_id:'7',result:{},error:null,review_url:null,created_at:'2026-09-21T12:00:00Z',started_at:null,finished_at:null};
test('video creation sends a completed article reference and current revision to SupportPages',async t=>{
 let body;
 const f=await fixture(t,async(url,init)=>{
  if(url.endsWith('/context'))return Response.json(metadata);
  if(url.includes('/writer/capabilities'))return Response.json({version:1,decision});
  if(url.endsWith('/articles/5'))return Response.json(remote);
  body=JSON.parse(init.body);return Response.json(operation);
 });f.bridge.skillsDir='/no-local-article-skills';await f.bridge.bind('1');
 const result=await f.bridge.createWalkthrough({article_id:'5'});
 assert.equal(result.walkthrough_id,'7');
 assert.deepEqual(body,{action_name:'create_video_walkthrough',input:{article_id:'5',expected_revision:remote.revision}});
 assert.equal(await f.ws.exists('.rtfm/supportpages/active-run.json'),false);
});
test('video eligibility blocks submission without recording or generating locally',async t=>{
 for(const code of ['plan_limit','generation_running','unsupported_article_format','article_incomplete']) {
  let posts=0;
  const f=await fixture(t,async(url,init)=>{
   if(init.method==='POST')posts++;
   if(url.endsWith('/context'))return Response.json(metadata);
   return Response.json({version:1,decision:{...decision,allowed:false,next_step:{code,message:'Choose an eligible article.',requested_action:'create_video_walkthrough'}}});
  });await f.bridge.bind('1');
  const result=await f.bridge.createWalkthrough({article_id:'5'});
  assert.equal(result.next_step.code,code);assert.equal(posts,0);
 }
});
test('real Rails completed walkthrough result exposes private playback and durable identity',async t=>{
 const {readFile}=await import('node:fs/promises');
 const raw=JSON.parse(await readFile(new URL('fixtures/contracts/writer-walkthrough-v1.json',import.meta.url),'utf8'));
 const meta={...metadata,project:{...metadata.project,id:raw.project_id}};
 const f=await fixture(t,async url=>Response.json(url.endsWith('/context')?meta:raw));
 f.bridge.api.origin=new URL(raw.review_url).origin;await f.bridge.bind(raw.project_id);
 const result=await f.bridge.hosted.get(raw.id);
 assert.equal(result.status,'succeeded');assert.equal(result.walkthrough_id,raw.walkthrough_id);
 assert.equal(result.result.publication_pending,true);assert.equal(result.result.playback_url,raw.result.playback_url);
});
