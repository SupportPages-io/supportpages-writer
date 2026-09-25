import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, context, remote, article } from './helpers.mjs';
import { writerAction } from '../dist/actions.js';
const allowed=action=>({action,allowed:true,execution:'remote',required_scopes:['read','manage'],next_step:null});
const metadata={...context,repository_connection:{...context.repository_connection,writer:{version:1,actions:Object.fromEntries(writerAction.options.map(action=>[action,allowed(action)]))}}};

test('ID-addressed mutations do not require a bundle or a local article record',async t=>{
 const calls=[];
 const f=await fixture(t,async(url,init)=>{
  calls.push({url,method:init.method,body:init.body && JSON.parse(init.body)});
  if(url.endsWith('/context'))return Response.json(metadata);
  if(url.includes('/writer/capabilities'))return Response.json({version:1,decision:allowed(new URL(url).searchParams.get('action_name'))});
  if(init.method==='DELETE')return Response.json({id:'5',deleted_at:'2026-09-21T12:00:00.000000Z'});
  return Response.json({...remote,title:article.title,content:article});
 });
 await f.bridge.bind('1');
 for(const action of ['update_article','publish_article','unpublish_article','delete_article']) {
  const input={article_id:'5',expected_revision:remote.revision,...(action==='update_article'?{structured_content:article}:{})};
  const result=await f.bridge.mutateArticle(action,input);assert.equal(result.id,'5');
 }
 assert.deepEqual(calls.filter(c=>c.method!=='GET').map(c=>c.method),['PATCH','POST','POST','DELETE']);
 assert.ok(calls.filter(c=>c.method!=='GET').every(c=>c.body.expected_revision===remote.revision && !('bundle_hash' in c.body)));
 assert.equal(await f.ws.exists('.rtfm/supportpages/articles'),false);
 assert.equal(await f.ws.exists('.rtfm/supportpages/active-run.json'),false);
});
test('publication-specific permission blocks a live update before content is sent',async t=>{
 let writes=0;
 const f=await fixture(t,async(url,init)=>{
  if(init.method!=='GET')writes++;
  if(url.endsWith('/context'))return Response.json(metadata);
  return Response.json({version:1,decision:{...allowed('update_article'),allowed:false,next_step:{code:'permission_required',message:'Approve live editing.',requested_action:'update_article',missing_scopes:['publish']}}});
 });
 await f.bridge.bind('1');
 await assert.rejects(f.bridge.mutateArticle('update_article',{article_id:'5',expected_revision:remote.revision,structured_content:article}),{code:'permission_required'});
 assert.equal(writes,0);
});
test('revision conflicts are surfaced and never retried or replaced with an upload',async t=>{
 let writes=0;
 const f=await fixture(t,async(url,init)=>{
  if(url.endsWith('/context'))return Response.json(metadata);
  if(url.includes('/writer/capabilities'))return Response.json({version:1,decision:allowed('update_article')});
  writes++;return Response.json({error:{code:'revision_conflict'}},{status:409});
 });
 await f.bridge.bind('1');
 await assert.rejects(f.bridge.mutateArticle('update_article',{article_id:'5',expected_revision:remote.revision,structured_content:article}),{code:'revision_conflict'});
 assert.equal(writes,1);
});
test('reads and mutation responses cannot silently substitute another article',async t=>{
 const f=await fixture(t,async(url)=>{
  if(url.endsWith('/context'))return Response.json(metadata);
  if(url.includes('/writer/capabilities'))return Response.json({version:1,decision:allowed('publish_article')});
  return Response.json({...remote,id:'6'});
 });await f.bridge.bind('1');
 await assert.rejects(f.bridge.getArticle('5'),{code:'invalid_response'});
 await assert.rejects(f.bridge.mutateArticle('publish_article',{article_id:'5',expected_revision:remote.revision}),{code:'invalid_response'});
});

test('real Rails article contract preserves identity, revision, content and publication state',async t=>{
 const {readFile}=await import('node:fs/promises');
 const raw=JSON.parse(await readFile(new URL('fixtures/contracts/writer-article-v1.json',import.meta.url),'utf8'));
 const f=await fixture(t,async url=>Response.json(url.endsWith('/context')?metadata:raw));await f.bridge.bind('1');
 const result=await f.bridge.getArticle(raw.id);
 for(const key of ['id','revision','status','content_format','content','title','source'])assert.deepEqual(result[key],raw[key]);
});
