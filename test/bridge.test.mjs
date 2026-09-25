import test from 'node:test';
import assert from 'node:assert/strict';
import { symlink, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { analysedFixture as fixture, article, remote, context } from './helpers.mjs';
import { verifyBundle } from '../dist/artifacts.js';
import { apiOrigin, ApiClient } from '../dist/api.js';

test('finalize, preview, upload and publish a complete article with a minimal allowlisted multipart bundle', async t => {
  const calls = [];
  const f = await fixture(t, async (url, init) => {
    calls.push({url, init});
    if (url.endsWith('/context')) return Response.json(context);
    if (url.endsWith('/article_imports')) return Response.json({import_id:'7',article:remote});
    return Response.json({...remote,status:'published',public_url:'https://example.supportpages.io/invite'});
  });
  await f.output();
  await f.ws.write('output/articles/invite/view_sources.json', 'PRIVATE SOURCE LEDGER');
  await f.ws.write('output/articles/invite/block_invite.html', '<script>private()</script>');
  const finalized = await f.bridge.finalize({ artifact_dir:'output/articles/invite',completed:true,section_id:'2' });
  assert.equal(finalized.status,'finalized');
  await verifyBundle(f.ws, finalized.bundle_dir);
  const view = await f.bridge.preview('output/articles/invite');
  assert.match(view.uri,/^file:/);
  const html = (await f.ws.read(path.relative(f.root, view.path))).toString();
  assert.match(html,/<strong>Invite<\/strong>/);
  assert.match(html,/data:image\/png;base64/);
  await f.bridge.bind('1');
  await f.bridge.upload('invite');
  const upload = calls.find(c=>c.url.endsWith('/article_imports'));
  assert.deepEqual([...upload.init.body.keys()], ['manifest','article','images[invite]']);
  assert.equal(upload.init.headers['Idempotency-Key'], finalized.bundle_hash);
  const manifest = JSON.parse(upload.init.body.get('manifest'));
  assert.equal(manifest.section_id,'2');
  const result = await f.bridge.publish('invite',remote.revision);
  assert.equal(result.status,'published');
  assert.equal(JSON.parse(calls.at(-1).init.body).bundle_hash,finalized.bundle_hash);
});

test('snapshot is isolated from later source edits, but tampering with the snapshot is rejected', async t => {
  const f=await fixture(t); await f.output();
  const result=await f.bridge.finalize({artifact_dir:'output/articles/invite',completed:true});
  await f.ws.writeJson('output/articles/invite/article.json',{...article,title:'Edited locally'});
  assert.equal((await verifyBundle(f.ws,result.bundle_dir)).snap.article.title,article.title);
  await f.ws.writeJson(`${result.bundle_dir}/article.json`,{...article,title:'Tampered'});
  await assert.rejects(verifyBundle(f.ws,result.bundle_dir),{code:'artifact_changed'});
});

test('reject duplicate IDs, missing images, failed lint, malformed and oversized PNGs', async t => {
  const f=await fixture(t); await f.output({...article,blocks:[...article.blocks,article.blocks[0]]});
  await assert.rejects(f.bridge.validate('output/articles/invite'),{code:'invalid_artifact'});
  await f.output(); await rm(path.join(f.root,'output/articles/invite/block_invite.png'));
  await assert.rejects(f.bridge.validate('output/articles/invite'),{code:'missing_artifact'});
  await f.output(); await f.ws.writeJson('output/articles/invite/lint_report.json',{all_passed:false});
  await assert.rejects(f.bridge.finalize({artifact_dir:'output/articles/invite',completed:true}),{code:'quality_check_failed'});
  await f.output(); await f.ws.write('output/articles/invite/block_invite.png','not png');
  await assert.rejects(f.bridge.validate('output/articles/invite'),{code:'invalid_artifact'});
});

test('workspace traversal and symlink escapes are denied for reads and writes',async t=>{
  const f=await fixture(t); const outside=await mkdtemp(path.join(os.tmpdir(),'supportpages-outside-'));
  t.after(()=>rm(outside,{recursive:true,force:true}));
  await symlink(outside,path.join(f.root,'escape'));
  await assert.rejects(f.ws.read('../outside'),{code:'invalid_path'});
  await assert.rejects(f.ws.write('escape/token','secret'),{code:'invalid_path'});
  await assert.rejects(f.ws.read('escape/token'),{code:'invalid_path'});
});

test('prepared generation requires its run ID and final lint; cancellation releases workspace',async t=>{
  const f=await fixture(t); await f.bridge.bind('1');
  const run=await f.bridge.prepare({title:'Invite',article_type:'how-to',section_id:'2'});
  assert.equal(run.status,'prepared');
  await assert.rejects(f.bridge.prepare({title:'Another',article_type:'how-to'}),{code:'generation_active'});
  await f.output();
  await assert.rejects(f.bridge.finalize({artifact_dir:'output/articles/invite',completed:true}),{code:'invalid_run'});
  await f.bridge.finalize({artifact_dir:run.artifact_dir,completed:true,run_id:run.run_id});
  await assert.rejects(f.bridge.prepare({title:'Invite',article_type:'how-to'}),{code:'output_exists'});
  const next=await f.bridge.prepare({title:'Another',article_type:'how-to'});
  assert.equal((await f.bridge.cancel(next.run_id)).status,'cancelled');
});

test('local preview makes scripts, remote links and image requests inert',async t=>{
  const f=await fixture(t); await f.output({...article,title:'<script>alert(1)</script>',blocks:[{id:'body',type:'prose',presentation:'body',content:'<script>alert(1)</script> [click](javascript:alert) ![secret](https://evil.invalid/token)'}]});
  const result=await f.bridge.preview('output/articles/invite');
  const html=(await f.ws.read(path.relative(f.root,result.path))).toString();
  assert.doesNotMatch(html,/<script|href=|src="https:/);
  assert.match(html,/Content-Security-Policy/);
});

test('API protects credentials and maps remote failures without echoing their body',async()=>{
  assert.throws(()=>apiOrigin('http://example.com'),{code:'invalid_configuration'});
  assert.throws(()=>apiOrigin('https://secret:pass@example.com'),{code:'invalid_configuration'});
  assert.throws(()=>apiOrigin('https://example.com/path'),{code:'invalid_configuration'});
  assert.equal(apiOrigin('http://127.0.0.1:3000'),'http://127.0.0.1:3000');
  const api=new ApiClient('https://app.supportpages.io','secret',async(url,opts)=>{
    assert.equal(opts.redirect,'error');
    return new Response('secret leaked in upstream diagnostic',{status:409});
  });
  await assert.rejects(api.request('POST','/projects'), e=>e.code==='revision_conflict'&&!e.message.includes('secret'));
  await assert.rejects(new ApiClient('https://app.supportpages.io').request('GET','/projects'),{code:'missing_credentials'});
});

test('repeated upload retains idempotency key; publish rejects an unreviewed local revision',async t=>{
  const keys=[];
  const f=await fixture(t,async(url,init)=>{
    if(url.endsWith('/context')) return Response.json(context);
    keys.push(init.headers['Idempotency-Key']); return Response.json({import_id:'7',article:remote});
  });
  await f.bridge.bind('1'); await f.output(); await f.bridge.finalize({artifact_dir:'output/articles/invite',completed:true});
  await f.bridge.upload('invite');await f.bridge.upload('invite');
  assert.equal(keys[0],keys[1]);
  await assert.rejects(f.bridge.publish('invite','b'.repeat(64)),{code:'revision_conflict'});
});

test('golden bundle has stable cross-language checksums',async()=>{
  const {Workspace}=await import('../dist/workspace.js');
  const ws=await Workspace.create(path.resolve('test/fixtures'));
  const bundle=await verifyBundle(ws,'bundle');
  assert.equal(bundle.manifest.local_article_id,'00000000-0000-4000-8000-000000000001');
});

test('publication before upload fails locally and does not send a request',async t=>{
  let requests=0;
  const f=await fixture(t,async()=>{requests++;return Response.json(context)});
  await f.bridge.bind('1');await f.output();await f.bridge.finalize({artifact_dir:'output/articles/invite',completed:true});
  await assert.rejects(f.bridge.publish('invite',remote.revision),{code:'not_uploaded'});
  assert.equal(requests,1);
});

test('new local snapshots retain the section and require upload before publishing',async t=>{
  let calls=0;
  const f=await fixture(t,async(url, init)=>{
    if(init.method==='POST') calls++;
    return Response.json(url.endsWith('/context')?context:{import_id:'7',article:remote});
  });
  await f.bridge.bind('1');await f.output();
  await f.bridge.finalize({artifact_dir:'output/articles/invite',completed:true,section_id:'2'});
  await f.bridge.upload('invite');
  await f.output({...article,title:'Updated invitation guide'});
  const updated=await f.bridge.finalize({artifact_dir:'output/articles/invite',completed:true});
  assert.equal((await verifyBundle(f.ws,updated.bundle_dir)).manifest.section_id,'2');
  await assert.rejects(f.bridge.publish('invite',remote.revision),{code:'not_uploaded'});
  assert.equal(calls,1);
});

test('HTTP 403 distinguishes hosting limits, repository requirements and permission errors without exposing response text', async () => {
  for (const code of ['plan_limit', 'repository_connection_required', 'permission_denied']) {
    const api = new ApiClient('https://app.supportpages.io', 'secret', async () => Response.json({ error: { code, message: 'PRIVATE_TOKEN upstream message' } }, { status: 403 }));
    await assert.rejects(api.request('POST', '/projects/88/article_imports'), error => {
      assert.equal(error.code, code);
      assert.ok(!error.message.includes('PRIVATE_TOKEN'));
      if (code === 'plan_limit') assert.match(error.message, /article hosting limit/);
      return true;
    });
  }
  const fallback = new ApiClient('https://app.supportpages.io', 'secret', async () => Response.json({ error: { code: 'invented', message: 'PRIVATE_TOKEN' } }, { status: 403 }));
  await assert.rejects(fallback.request('POST', '/projects/88/article_imports'), error => error.code === 'permission_denied' && !error.message.includes('PRIVATE_TOKEN'));
});

test('oversized and status-mismatched error bodies retain the safe HTTP fallback', async () => {
  for (const response of [
    new Response(JSON.stringify({ padding: 'x'.repeat(9000), error: { code: 'plan_limit' } }), { status: 403 }),
    Response.json({ error: { code: 'plan_limit' } }, { status: 401 }),
  ]) {
    const api = new ApiClient('https://app.supportpages.io', 'secret', async () => response);
    await assert.rejects(api.request('POST', '/projects/88/article_imports'), { code: response.status === 401 ? 'invalid_credentials' : 'permission_denied' });
  }
});
