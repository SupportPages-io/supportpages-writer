import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, rm, lstat, symlink } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { repository, environment, chooseHelpCentre, runCli } from '../scripts/lib/cli.mjs';
import { Session, credentialLocation } from '../dist/session.js';
import { readCredential, saveTokenFile } from '../dist/credentials.js';
import { fixture, context, seedAnalysis } from './helpers.mjs';
import { setupInvitation, hostingBenefits } from '../dist/hosting-benefits.js';
import { Cancelled } from '../scripts/lib/terminal.mjs';

const origin='https://app.supportpages.io';
const token='sp_local_'+'b'.repeat(64);
const account={id:'10',email:'alice@example.com'};
const writingStyles = { friendly: 'Friendly & conversational', minimal: 'Minimal & scannable', technical: 'Technical & precise', formal: 'Formal & professional' };
const settings={account,preferences:{prefer_background:true,open_when_ready:false},writing_styles:writingStyles,can_create_project:true};
const projects={projects:[{id:'1',name:'Example',help_centre_url:'https://example.supportpages.io'}]};
/** Token-authenticated API stub covering everything terminal setup touches. */
function api(overrides={}) {
  const patches=overrides.patches ?? [];
  return async (method,route,body)=>{
    if(route==='/mcp/settings' && method==='GET') return overrides.settings ?? settings;
    if(route==='/projects' && method==='GET') return overrides.projects ?? projects;
    if(route==='/projects' && method==='POST') return overrides.create ? overrides.create(body) : {project:{id:'2',name:body.name,subdomain:body.subdomain}};
    if(route.endsWith('/context') && method==='GET') return overrides.context ? overrides.context(route) : context;
    if(method==='PATCH') {patches.push({route,body});return {};}
    throw Error(`Unexpected ${method} ${route}`);
  };
}
const stubSession=(f)=>({options:{workspace:f.root,origin,dev:false},workspace:async()=>f.ws});

test('repository discovery preserves bindings inside the current repository and supports explicit and non-git directories',async t=>{
  const f=await fixture(t);await mkdir(path.join(f.root,'src/deep'),{recursive:true});
  const run=async()=>({code:0,stdout:f.root+'\n'});
  assert.equal(await repository({command:'init'},{cwd:path.join(f.root,'src'),run}),f.root);
  await f.ws.writeJson('src/.rtfm/supportpages/binding.json',{});
  assert.equal(await repository({command:'init'},{cwd:path.join(f.root,'src/deep'),run}),path.join(f.root,'src'));
  assert.equal(await repository({workspace:f.root},{cwd:path.join(f.root,'src'),run}),f.root);
  assert.equal(await repository({command:'init'},{cwd:f.root,run:async()=>({code:1})}),f.root);
});

test('a parent connection cannot capture a child Git checkout or a checkout with a .git file', async t => {
  const f = await fixture(t);
  await f.ws.writeJson('.rtfm/supportpages/binding.json', { project_id: '1' });
  await f.ws.writeJson('.rtfm/supportpages/dev/1234567890abcdef/binding.json', { project_id: '1' });
  const run = async (cmd, args, opts) => {
    const result = spawnSync(cmd, args, { cwd: opts.cwd, encoding: 'utf8' });
    return { code: result.status, stdout: result.stdout };
  };
  for (const separate of [false, true]) {
    const repo = path.join(f.root, separate ? 'git-file-checkout' : 'child-checkout');
    const init = spawnSync('git', ['init', '--quiet', ...(separate ? ['--separate-git-dir', path.join(f.root, 'git-metadata')] : []), repo], { encoding: 'utf8' });
    assert.equal(init.status, 0, init.stderr);
    await mkdir(path.join(repo, 'src'), { recursive: true });
    assert.equal(await repository({ command: 'init' }, { cwd: repo, run }), repo);
    assert.equal(await repository({ command: 'init' }, { cwd: path.join(repo, 'src'), run }), repo);
    assert.equal(await repository({ workspace: f.root }, { cwd: repo, run }), f.root);
  }
});

test('workspace environment is remembered with explicit options taking priority and status remains read only',async t=>{
  const f=await fixture(t);const configDir=path.join(f.root,'config');
  const profile=path.join(configDir,'workspaces',createHash('sha256').update(f.root).digest('hex')+'.json');
  await mkdir(path.dirname(profile),{recursive:true});
  await writeFile(profile,JSON.stringify({version:1,workspace:f.root,origin:'http://app.lvh.me:3000',dev:true}));
  const saved=await environment(f.root,{'config-dir':configDir},{});
  assert.equal(saved.dev,true);assert.equal(saved.origin,'http://app.lvh.me:3000');
  assert.equal((await environment(f.root,{'config-dir':configDir,'api-url':origin},{})).origin,origin);
  const logs=[];
  await runCli({command:'status',workspace:f.root,'config-dir':configDir,json:true},{installRoot:path.resolve('.'),ui:{line:s=>logs.push(s)},run:async()=>({code:1}),env:{SUPPORTPAGES_API_URL:undefined,SUPPORTPAGES_DEV:undefined}});
  assert.equal(JSON.parse(logs[0]).status,'setup_required');
  assert.equal(await f.ws.exists('.rtfm'),false);
});

test('terminal help-centre selection binds an existing help centre and saves the writing style without a browser',async t=>{
  const f=await fixture(t);const patches=[],prompts=[],logs=[];
  f.bridge.api.request=api({patches});
  const ui={line:s=>logs.push(s),ok:s=>logs.push(s),confirm:async question=>{prompts.push(question);return true;},
    choose:async question=>question==='Choose a help centre'?'1':question==='Writing style'?'minimal':assert.fail(question)};
  const result=await chooseHelpCentre(stubSession(f),f.bridge,{ui});
  assert.equal(result.project_id,'1');assert.equal(result.name,'Example');assert.equal(result.help_centre_url,'https://example.supportpages.io');
  assert.equal((await f.bridge.binding()).project_id,'1');
  assert.deepEqual(patches,[{route:'/projects/1',body:{writing_style:'minimal'}}]);
  assert.deepEqual(prompts,['Connect this help centre?']);
  assert.equal(await f.ws.exists('output'),false);
});

test('first help centre creation preserves corrections and defaults without a destination picker',async t=>{
  const f=await fixture(t);let attempts=0;const prompts=[],creates=[];
  f.bridge.api.request=api({projects:{projects:[]},create:body=>{creates.push(body);if(attempts++===0) throw Object.assign(Error('Address unavailable'),{code:'invalid_artifact'});return {project:{id:'1',name:body.name,subdomain:body.subdomain}};}});
  const ui={line:()=>{},ok:()=>{},choose:async(question,choices,index)=>{assert.equal(question,'Writing style');return choices[index].value;},
    confirm:async question=>{prompts.push(question);return true;},ask:async(question,fallback)=>{
      if(question==='Help centre name') {if(attempts) assert.equal(fallback,'New product');return 'New product';}
      assert.equal(fallback,'new-product');return attempts?'new-product-2':'new-product';
    }};
  const result=await chooseHelpCentre(stubSession(f),f.bridge,{ui});
  assert.equal(result.project_id,'1');assert.equal(result.name,'New product');
  assert.equal(creates[1].subdomain,'new-product-2');
  assert.deepEqual(prompts,['Create this help centre?','Review your choices and try again?','Create this help centre?']);
  assert.equal((await f.bridge.binding()).project_id,'1');
});

test('fixed-project setup skips selection and refuses access from a different account',async t=>{
  const f=await fixture(t);
  f.bridge.api.request=api();
  const ui={line:()=>{},ok:()=>{},confirm:async()=>true,choose:async(question,choices,index)=>{assert.equal(question,'Writing style');return choices[index].value;}};
  assert.equal((await chooseHelpCentre(stubSession(f),f.bridge,{ui},{bound:'1'})).project_id,'1');
  f.bridge.api.request=api({projects:{projects:[]}});
  await assert.rejects(chooseHelpCentre(stubSession(f),f.bridge,{ui},{bound:'1'}),{code:'permission_denied'});
});

test('creating at the plan limit opens billing before details and resumes after upgrading',async t=>{
  const f=await fixture(t),events=[];
  const limited={...settings,can_create_project:false,project_creation_upgrade_url:origin+'/billing'};
  f.bridge.api.request=api({settings:limited,create:body=>{
    events.push('create');return {project:{id:'1',name:body.name,subdomain:body.subdomain}};
  }});
  const ui={line:()=>{},choose:async(question,choices)=>{
    if(question==='Writing style') return 'friendly';
    assert.ok(choices.some(choice=>choice.value==='new'));return 'new';
  },confirm:async question=>{
    events.push(question);
    if(question==='Check your plan and continue?') limited.can_create_project=true;
    return true;
  },ask:async question=>{
    assert.equal(limited.can_create_project,true);events.push(question);
    return question==='Help centre name'?'Product':'product';
  }};
  await chooseHelpCentre(stubSession(f),f.bridge,{ui,open:async url=>{
    assert.equal(url,origin+'/billing');events.push('open');return true;
  }});
  assert.deepEqual(events,['open','Check your plan and continue?','Help centre name','Help centre address name','Create this help centre?','create']);
  assert.equal((await f.bridge.binding()).project_id,'1');
});

test('declining or not completing an upgrade returns to existing help centres and browser failure shows the link',async t=>{
  for(const recheck of [false,true]) {
    const f=await fixture(t),logs=[];let selections=0,opened=0;
    f.bridge.api.request=api({settings:{...settings,can_create_project:false,project_creation_upgrade_url:origin+'/billing'},
      create:()=>assert.fail('Must not create before upgrading')});
    const ui={line:s=>logs.push(s),ask:()=>assert.fail('Must not ask for details'),
      choose:async question=>question==='Writing style'?'friendly':selections++===0?'new':'1',
      confirm:async question=>question==='Check your plan and continue?'?recheck:true};
    await chooseHelpCentre(stubSession(f),f.bridge,{ui,open:async()=>{opened++;return false;}});
    assert.equal(opened,1);assert.ok(logs.some(line=>line.includes(origin+'/billing')));
    assert.equal((await f.bridge.binding()).project_id,'1');
  }
});

test('cancelling the upgrade prompt keeps the existing connection untouched',async t=>{
  const f=await fixture(t);f.bridge.api.request=api();await f.bridge.bind('1');
  f.bridge.api.request=api({settings:{...settings,can_create_project:false,project_creation_upgrade_url:origin+'/billing'}});
  const ui={line:()=>{},choose:async()=> 'new',confirm:async()=>{throw new Cancelled();}};
  await assert.rejects(chooseHelpCentre(stubSession(f),f.bridge,{ui,open:async()=>true},{replaceProjectId:'1'}),Cancelled);
  assert.equal((await f.bridge.binding()).project_id,'1');
});

test('permission restrictions do not offer an upgrade and unsafe upgrade URLs are rejected',async t=>{
  const f=await fixture(t);
  f.bridge.api.request=api({settings:{...settings,can_create_project:false}});
  const ui={line:()=>{},confirm:async()=>true,choose:async(question,choices)=>{
    if(question==='Writing style') return 'friendly';
    assert.ok(!choices.some(choice=>choice.value==='new'));return '1';
  }};
  const deps={ui,open:()=>assert.fail('Must not open billing')};
  await chooseHelpCentre(stubSession(f),f.bridge,deps);
  for(const url of ['javascript:alert(1)','file:///tmp/billing','https://user:password@app.supportpages.io/billing']) {
    f.bridge.api.request=api({settings:{...settings,can_create_project:false,project_creation_upgrade_url:url}});
    await assert.rejects(chooseHelpCentre(stubSession(f),f.bridge,deps),{code:'invalid_response'});
  }
});

test('a plan limit reached during creation opens billing and preserves the draft',async t=>{
  const f=await fixture(t),current={...settings};let attempts=0,opened=0;
  f.bridge.api.request=api({settings:current,create:body=>{
    if(attempts++===0) {
      current.can_create_project=false;current.project_creation_upgrade_url=origin+'/billing';
      throw Object.assign(Error('Plan limit'),{code:'plan_limit'});
    }
    return {project:{id:'1',name:body.name,subdomain:body.subdomain}};
  }});
  const ui={line:()=>{},choose:async question=>question==='Writing style'?'friendly':'new',
    confirm:async question=>{if(question==='Check your plan and continue?') current.can_create_project=true;return true;},
    ask:async(question,fallback)=>{
      const answer=question==='Help centre name'?'Saved product':'saved-product';
      if(attempts) assert.equal(fallback,answer);return answer;
    }};
  await chooseHelpCentre(stubSession(f),f.bridge,{ui,open:async()=>{opened++;return true;}});
  assert.equal(opened,1);assert.equal(attempts,2);
});

test('writing-style selection preselects the saved style, defaults to friendly and keeps custom guidance', async t => {
  for (const [current, expected, patched] of [[undefined, 'friendly', 'friendly'], ['technical', 'technical', 'technical'], ['Write as a patient teacher.', 'keep', undefined]]) {
    const f = await fixture(t); const patches = [];
    f.bridge.api.request = api({ patches, context: () => ({ ...context, product_context: current === undefined ? {} : { tone_preference: current } }) });
    const ui = { line: () => {}, ok: () => {}, confirm: async () => true, choose: async (question, choices, index) => {
      assert.equal(question, 'Writing style'); assert.equal(choices[index].value, expected);
      if (!current || current === 'technical') assert.deepEqual(choices.map(choice => choice.value), Object.keys(writingStyles));
      return choices[index].value;
    } };
    await chooseHelpCentre(stubSession(f), f.bridge, { ui }, { bound: '1' });
    assert.deepEqual(patches, patched ? [{ route: '/projects/1', body: { writing_style: patched } }] : []);
  }
});

test('cancelling a writing-style choice saves nothing and leaves the folder unlinked', async t => {
  const f = await fixture(t); const patches = [];
  f.bridge.api.request = api({ patches });
  const ui = { line: () => {}, ok: () => {}, confirm: async () => true, choose: async () => { throw new Cancelled(); } };
  await assert.rejects(chooseHelpCentre(stubSession(f), f.bridge, { ui }, { bound: '1' }), Cancelled);
  assert.deepEqual(patches, []);
  assert.equal(await f.ws.exists('.rtfm/supportpages/binding.json'), false);
});

test('CLI help and version require no authentication and invalid/noninteractive input is actionable without echoing secrets',()=>{
  for(const flag of ['--help','--version']) assert.equal(spawnSync(process.execPath,['scripts/cli.mjs',flag],{encoding:'utf8'}).status,0);
  const invalid=spawnSync(process.execPath,['scripts/cli.mjs','init','--token=private-secret'],{encoding:'utf8'});
  assert.equal(invalid.status,2);assert.ok(!(invalid.stdout+invalid.stderr).includes('private-secret'));
  const unattended=spawnSync(process.execPath,['scripts/cli.mjs','init'],{encoding:'utf8'});
  assert.equal(unattended.status,2);assert.match(unattended.stderr,/interactive terminal/);
  const loginProject=spawnSync(process.execPath,['scripts/cli.mjs','login','--project','1'],{encoding:'utf8'});
  assert.equal(loginProject.status,2);
});

test('real terminal completes init with browser sign-in, terminal help-centre choice and mandatory agent analysis; a subsequent MCP session reuses readiness',async t=>{
  const f=await fixture(t),configDir=path.join(f.root,'config'),script=path.join(f.root,'terminal-init.mjs');
  const skills=path.join(f.root,'skills');
  await f.ws.write('skills/detect-project/SKILL.md', 'Write full analysis to RTFM_OUTPUT_DIR.');
  const agentScript = await f.ws.write('fake-analysis.cjs', `
    const fs=require('fs'),path=require('path');
    process.stdin.resume();process.stdin.on('end',()=>{
      if(process.env.RTFM_ANALYZE!=='full')process.exit(1);
      fs.mkdirSync('.rtfm',{recursive:true});
      fs.writeFileSync('.rtfm/branding.json',JSON.stringify({framework:'test'}));
      fs.writeFileSync('.rtfm/project_map.json',JSON.stringify({framework:'test',route_index:{home:{}}}));
      fs.writeFileSync('.rtfm/branding.css','body { color: black; }');
      fs.writeFileSync(path.join(process.env.RTFM_OUTPUT_DIR,'summary.md'),'A collaboration product.');
      fs.writeFileSync(path.join(process.env.RTFM_OUTPUT_DIR,'overview.txt'),'Helps teams work together.');
      console.log(JSON.stringify({type:'turn.completed'}));
    });
  `);
  await mkdir(path.join(skills,'generate-illustrated-article'),{recursive:true});
  await writeFile(path.join(skills,'generate-illustrated-article/SKILL.md'),'test');
  await writeFile(script,`
import {runCli} from ${JSON.stringify(path.resolve('scripts/lib/cli.mjs'))};
import {createTerminal} from ${JSON.stringify(path.resolve('scripts/lib/terminal.mjs'))};
import {Session} from ${JSON.stringify(path.resolve('dist/session.js'))};
import {runAgent} from ${JSON.stringify(path.resolve('scripts/lib/agent-runner.mjs'))};
import {spawn} from 'node:child_process';
globalThis.fetch=async(url,init)=>{
  if(url.endsWith('/pairings')) return Response.json({pairing_id:'a'.repeat(64),pairing_secret:'c'.repeat(64),verification_uri:${JSON.stringify(origin)}+'/settings/mcp/connect/'+'a'.repeat(64),user_code:'ABCD-EFGH',expires_at:new Date(Date.now()+600000).toISOString(),interval:3});
  if(url.endsWith('/poll')) return Response.json({status:'approved'});
  if(url.endsWith('/exchange')) return Response.json({status:'authorized',api_origin:${JSON.stringify(origin)},account:${JSON.stringify(account)},token:${JSON.stringify(token)},scopes:['read','import','projects:create'],token_expires_at:new Date(Date.now()+86400000).toISOString()});
  if(url.endsWith('/acknowledge')) return Response.json({status:'completed'});
  if(url.endsWith('/mcp/settings')) return Response.json(${JSON.stringify(settings)});
  if(url.endsWith('/projects')) return Response.json(${JSON.stringify(projects)});
  if(url.endsWith('/projects/1') && init.method==='PATCH') return Response.json({project:{id:'1',name:'Example',writing_style:JSON.parse(init.body).writing_style}});
  if(url.endsWith('/context')) return Response.json(${JSON.stringify(context)});
  throw Error('Unexpected endpoint '+url);
};
await runCli({command:'init',workspace:${JSON.stringify(f.root)},'skills-dir':${JSON.stringify(skills)},'config-dir':${JSON.stringify(configDir)}},{installRoot:${JSON.stringify(path.resolve('.'))},ui:createTerminal(),discoverModels:async()=>[{value:'test-codex',label:'Test Codex',isDefault:true}],open:async()=>false,openAgent:async()=>true,run:async cmd=>({code:cmd==='claude'?1:0}),runAgent:value=>{if(value.model!=='test-codex') throw Error('Analysis must use the selected model');return runAgent({...value,spawnProcess:(_cmd,_args,settings)=>spawn(process.execPath,[${JSON.stringify(agentScript)}],settings)});},install:async()=>({skillsDir:${JSON.stringify(skills)},clients:['codex']}),env:{SUPPORTPAGES_API_URL:undefined,SUPPORTPAGES_DEV:undefined}});
const session=new Session({workspace:${JSON.stringify(f.root)},cwd:${JSON.stringify(f.root)},origin:${JSON.stringify(origin)},dev:false,configDir:${JSON.stringify(configDir)},skillsDir:''});
if(!(await session.init({})).generation_ready) throw Error('MCP did not reuse the saved connection and analysis');
session.close();
`);
  const python=`
import os,pty,select,subprocess,sys,time
master,slave=pty.openpty()
p=subprocess.Popen([sys.argv[1],sys.argv[2]],stdin=slave,stdout=slave,stderr=slave,env={**os.environ,'TERM':'dumb'})
os.close(slave)
buf=b''
prompts=[(b'This computer is not set up for SupportPages Writer yet.',b'y\\r'),(b'Add SupportPages Writer to',b'y\\r'),(b'How would you like to get started?',b'1\\r'),(b'Write articles in the background when available?',b'y\\r'),(b'Open completed drafts in your browser?',b'y\\r'),(b'Where should finished articles go?',b'\\r'),(b'Choose a help centre',b'\\r'),(b'Connect this help centre?',b'y\\r'),(b'Writing style',b'\\r'),(b'Change the Codex model?',b'n\\r'),(b'Run the analysis now with Codex?',b'y\\r')]
cursor=0
deadline=time.time()+15
try:
    while time.time()<deadline:
        if select.select([master],[],[],0.1)[0]:
            try: buf+=os.read(master,8192)
            except OSError: break
        if cursor<len(prompts) and prompts[cursor][0] in buf:
            os.write(master,prompts[cursor][1]);cursor+=1
        if p.poll() is not None: break
    p.wait(timeout=2)
    assert p.returncode==0,buf.decode(errors='replace')
    assert cursor==len(prompts),buf.decode(errors='replace')
    assert b'Open Codex in this project and ask for an article' in buf,buf.decode(errors='replace')
    assert b'Signed in as alice@example.com' in buf,buf.decode(errors='replace')
    assert b'This project is ready' in buf,buf.decode(errors='replace')
    assert b'https://example.supportpages.io' in buf,buf.decode(errors='replace')
    assert b'sp_local_' not in buf and b'cccccccccccccccc' not in buf
finally:
    if p.poll() is None: p.kill()
    os.close(master)
`;
  const result=spawnSync('python3',['-c',python,process.execPath,script],{encoding:'utf8',timeout:20000});
  assert.equal(result.status,0,result.stderr);
  assert.deepEqual(await readCredential(credentialLocation(origin,configDir).filename,origin),{token,account});
});

test('npm-style executable symlinks resolve the package rather than the bin directory',async t=>{
  const f=await fixture(t),link=path.join(f.root,'supportpages');
  await symlink(path.resolve('scripts/cli.mjs'),link);
  const result=spawnSync(process.execPath,[link,'--version'],{encoding:'utf8'});
  const {version}=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
  assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.trim(),version);
});

async function configuredCli(t, {available=['codex'], managed=true, status='ready'}={}) {
  const f=await fixture(t), configDir=path.join(f.root,'config'),skills=path.join(f.root,'skills');
  await mkdir(path.join(skills,'generate-illustrated-article'),{recursive:true});
  await writeFile(path.join(skills,'generate-illustrated-article/SKILL.md'),'test');
  if(managed) {
    await mkdir(path.join(configDir,'installations'),{recursive:true});
    await writeFile(path.join(configDir,'installations/supportpages.json'),JSON.stringify({clients:available}));
    await writeFile(path.join(configDir,'installations/supportpages.mcp.json'),JSON.stringify({mcpServers:{supportpages:{args:['--api-url',origin,'--skills-dir',skills]}}}));
  }
  await seedAnalysis(f.ws);
  await f.ws.writeJson('.rtfm/supportpages/binding.json',{version:1,api_origin:origin,project_id:'1'});
  const logs=[],prompts=[],calls=[];
  const session={options:{},bridge:async()=>f.bridge,workspace:async()=>f.ws,
    login:async()=>{calls.push(['login']);return {status:'signed_in',api_origin:origin,account,already_signed_in:true};},
    status:async()=>({status,account,project_id:'1',project:{id:'1',name:'Example',help_centre_url:'https://example.supportpages.io'}}),close:()=>{}};
  const deps={discoverModels:async agent=>agent==='claude' ? [{value:'sonnet',label:'Sonnet',isDefault:true},{value:'opus',label:'Opus'}] : [{value:'test-codex',label:'Test Codex',isDefault:true}],home:path.join(f.root,'home'),installCodex:async options=>{calls.push(['codex-integration',options]);},installRoot:path.resolve('.'),env:{SUPPORTPAGES_API_URL:undefined,SUPPORTPAGES_DEV:undefined},
    sessionFactory:options=>{session.options=options;return session;},
    run:async(cmd,args)=>{calls.push([cmd,args]);return {code:['codex','claude'].includes(cmd) && !available.includes(cmd)?1:0};},
    ui:{line:value=>logs.push(value),ok:value=>logs.push(value),confirm:async value=>{prompts.push(value);return !value.startsWith('Change the ');},choose:async (question,choices,index=0)=>question==='What would you like to do next?'?'write':choices[index].value},
    openAgent:async()=>true,
    install:async()=>assert.fail('Healthy integration must be reused')};
  return {f,configDir,skills,logs,prompts,calls,session,deps,options:{command:'init',workspace:f.root,'config-dir':configDir,'skills-dir':skills}};
}

test('healthy repeat init verifies readiness without reinstalling and states the model before asking to change it',async t=>{
  const h=await configuredCli(t);
  await runCli(h.options,h.deps);
  assert.deepEqual(h.prompts,[
    'Keep publishing to this help centre?',
    'Change the writing style for this help centre?',
    'Change the Codex model?',
  ]);
  assert.match(h.logs.join('\n'),/Codex will write this project’s articles with Test Codex at /);
  assert.ok(h.prompts.includes('Keep publishing to this help centre?'));
  assert.ok(h.calls.some(([command])=>command==='login'));
  assert.match(h.logs.join('\n'),/This project publishes to Example\nhttps:\/\/example.supportpages.io/);
  assert.match(h.logs.join('\n'),/Ready to write/);
  assert.match(h.logs.join('\n'),/https:\/\/example.supportpages.io/);
  assert.match(h.logs.join('\n'),/Project analysis is ready/);
  assert.doesNotMatch(h.logs.join('\n'),/Restart/);
  assert.ok(h.calls.some(([command, options]) => command === 'codex-integration' && options.name === 'supportpages'));
});

test('repeat init clears an abandoned writer through the terminal and reuses existing analysis', async t => {
  const h = await configuredCli(t, { available: ['claude'] });
  const prepared = await h.f.bridge.prepare({ title: 'Invite', article_type: 'how-to' });
  await h.f.bridge.updateRun({ run_id: prepared.run_id, event: 'started', execution_mode: 'foreground' });
  await h.f.output();
  const before = await h.f.ws.read(`${prepared.artifact_dir}/article.json`);
  let recoveryPrompts = 0, launched = false;
  h.deps.ui.choose = async (question, choices, index = 0) => {
    if (question === 'Coding agent for this project' || question.endsWith(' model') || question === 'Reasoning effort') return choices[index].value;
    assert.equal(question, 'How would you like to continue?');
    recoveryPrompts++;
    return choices[0].value;
  };
  h.deps.openAgent = async () => { launched = true; return true; };
  h.deps.runAgent = async () => assert.fail('Existing analysis should be reused');
  await runCli(h.options, h.deps);
  assert.equal(recoveryPrompts, 1);
  assert.equal(launched, false, 'init points to the coding agent instead of opening it');
  assert.equal((await h.f.bridge.runs.read(prepared.run_id)).status, 'cancelled');
  assert.deepEqual(await h.f.ws.read(`${prepared.artifact_dir}/article.json`), before);
  assert.match(h.logs.join('\n'), /Cleared the unfinished run/);
});

test('healthy Claude integration installs the persistent writer on repeat init', async t => {
  const h = await configuredCli(t, { available: ['claude'] });
  h.deps.ui.choose = async (_question, choices, index = 0) => choices[index].value;
  await runCli(h.options, h.deps);
  const filename = path.join(h.deps.home, '.claude/agents/supportpages-io.md');
  assert.match(await readFile(filename, 'utf8'), /name: supportpages-io/);
  const permissionsFile = path.join(h.deps.home, '.claude/settings.json');
  assert.deepEqual(JSON.parse(await readFile(permissionsFile, 'utf8')).permissions.allow, ['mcp__supportpages']);
  assert.match(h.logs.join('\n'), /Restart existing Claude sessions/);
  h.logs.length = 0;
  await runCli(h.options, h.deps);
  assert.doesNotMatch(h.logs.join('\n'), /Restart existing Claude sessions/);
  assert.doesNotMatch(h.logs.join('\n'), /Added Claude permission/);
});

test('init reaches this help centre\'s writing style through the API without a browser', async t => {
  const h = await configuredCli(t);
  const patches = [];
  h.f.bridge.api.request = api({ patches });
  h.deps.ui.confirm = async () => true;
  h.deps.ui.choose = async (question, choices, index = 0) => {
    if (question === 'Writing style') return 'formal';
    if (question === 'What would you like to do next?') return 'done';
    return choices[index].value;
  };
  await runCli(h.options, h.deps);
  assert.deepEqual(patches, [{ route: '/projects/1', body: { writing_style: 'formal' } }]);
});

test('setup saves account-wide documentation preferences through the API', async t => {
  const h = await configuredCli(t);
  const patches = [];
  h.f.bridge.api.request = api({ patches });
  h.deps.ui.choose = async (question, options, index) => {
    if (question === 'How would you like to get started?') return 'signin';
    return options[index].value;
  };
  h.deps.ui.confirm = async (question, initial) => {
    if (question.includes('background')) { assert.equal(initial, true); return false; }
    if (question.includes('Open completed drafts')) { assert.equal(initial, false); return true; }
    return true;
  };
  await runCli({ ...h.options, command: 'setup' }, h.deps);
  assert.deepEqual(patches, [{ route: '/mcp/settings', body: { preferences: { prefer_background: false, open_when_ready: true } } }]);
  assert.match(h.logs.join('\n'), /Documentation preferences saved for your account/);
});

test('configure is project-only: no account or help-centre settings are offered', async t => {
  const h = await configuredCli(t);
  let asked = false;
  h.f.bridge.api.request = async () => assert.fail('configure must not call the API for a hosted project');
  h.deps.ui.choose = async (question, options, index) => {
    if (question === 'What would you like to configure?') {
      asked = true;
      assert.deepEqual(options.map(option => option.value), []);
      return 'agent';
    }
    return options[index].value;
  };
  await runCli({ ...h.options, command: 'configure' }, h.deps);
  // A hosted project has exactly one project setting left, so there is no menu.
  assert.equal(asked, false);
  assert.ok(h.calls.some(([name, args]) => name === 'codex' && args?.[0] === 'mcp'));
});

test('repeat init can choose a different project, and cancellation preserves its existing link', async t => {
  for (const cancel of [true, false]) {
    const h = await configuredCli(t);
    let switched = false, selection = false;
    h.f.bridge.api.request = api({ projects: { projects: [...projects.projects, { id: '2', name: 'Another', help_centre_url: 'https://another.supportpages.io' }] } });
    h.session.switchProject = async (ws, from, to) => {
      assert.equal(ws, h.f.ws); assert.equal(from, '1'); assert.equal(to, '2');
      switched = true;
      return {};
    };
    h.deps.ui.confirm = async (question, initial) => {
      if (question === 'Keep publishing to this help centre?') { assert.equal(initial, true); return false; }
      if (question === 'Connect this help centre?') return !cancel;
      return true;
    };
    h.deps.ui.choose = async (question, choices, index) => {
      if (question === 'Choose a help centre') { selection = true; return '2'; }
      if (question === 'Writing style' || question === 'Coding agent for this project' || question.endsWith(' model') || question === 'Reasoning effort') return choices[index].value;
      return question === 'What would you like to do next?' ? 'done' : 'codex';
    };
    if (cancel) await assert.rejects(runCli(h.options, h.deps), Cancelled);
    else await runCli(h.options, h.deps);
    assert.equal(selection, true); assert.equal(switched, !cancel);
    assert.equal((await h.f.bridge.binding()).project_id, '1');
  }
});

test('an explicit different project requires confirmation and keeps that destination fixed', async t => {
  const h = await configuredCli(t);
  h.deps.ui.confirm = async question => !question.startsWith('Switch this repository');
  h.f.bridge.api.request = async () => assert.fail('Declining must not touch the API');
  await assert.rejects(runCli({ ...h.options, project: '2' }, h.deps), Cancelled);
  assert.equal((await h.f.bridge.binding()).project_id, '1');
  h.deps.ui.confirm = async () => true;
  h.f.bridge.api.request = api({ projects: { projects: [...projects.projects, { id: '2', name: 'Another' }] } });
  h.deps.ui.choose = async question => { assert.notEqual(question, 'Choose a help centre'); throw new Cancelled(); };
  await assert.rejects(runCli({ ...h.options, project: '2' }, h.deps), Cancelled);
  assert.equal((await h.f.bridge.binding()).project_id, '1');
});

test('an unavailable project or unverifiable link goes straight to unrestricted help-centre selection', async t => {
  for (const status of ['project_unavailable', 'authentication_required']) {
    const h = await configuredCli(t, { status });
    h.f.bridge.api.request = api();
    h.deps.ui.confirm = async question => {
      assert.notEqual(question, 'Keep publishing to this help centre?');
      return true;
    };
    h.deps.ui.choose = async question => { assert.equal(question, 'Choose a help centre'); throw new Cancelled(); };
    await assert.rejects(runCli(h.options, h.deps), Cancelled);
    assert.doesNotMatch(h.logs.join('\n'), /This repository is linked to Project 1/);
    assert.match(h.logs.join('\n'), status === 'project_unavailable' ? /may have been deleted/ : /could not be verified/);
    assert.equal((await h.f.bridge.binding()).project_id, '1');
  }
});

test('network failures do not describe the saved project as deleted or start replacement setup', async t => {
  const h = await configuredCli(t, { status: 'connection_error' });
  h.f.bridge.api.request = async () => assert.fail('Do not replace a project because the network failed');
  await assert.rejects(runCli(h.options, h.deps), { code: 'connection_error' });
  assert.doesNotMatch(h.logs.join('\n'), /deleted|no longer available|This repository is linked to Project/);
  assert.equal((await h.f.bridge.binding()).project_id, '1');
});

test('a deleted project can be replaced by a new help centre, while retaining analysis', async t => {
  const h = await configuredCli(t, { status: 'project_unavailable' });
  let connected = false, switched = false;
  h.f.bridge.api.request = api({ projects: { projects: [] }, create: body => ({ project: { id: '2', name: body.name, subdomain: body.subdomain } }),
    context: () => ({ ...context, project: { id: '2', name: 'Replacement' } }) });
  h.session.status = async () => ({ status: connected ? 'ready' : 'project_unavailable', account, project_id: connected ? '2' : '1', project: connected ? { id: '2', name: 'Replacement', help_centre_url: 'https://replacement.supportpages.io' } : undefined });
  h.session.switchProject = async (ws, from, to) => {
    assert.equal(from, '1'); assert.equal(to, '2');
    assert.equal((await h.f.bridge.binding()).project_id, '1');
    await ws.writeJson('.rtfm/supportpages/binding.json', { version: 1, api_origin: origin, project_id: '2' });
    connected = true; switched = true;
    return {};
  };
  h.deps.ui.confirm = async question => {
    assert.notEqual(question, 'Keep publishing to this help centre?');
    if (question === 'Create this help centre?') assert.equal(switched, false);
    return !question.startsWith('Open Codex');
  };
  h.deps.ui.ask = async (_question, initial) => initial;
  h.deps.ui.choose = async (_question, choices) => choices[0].value;
  h.deps.runAgent = async () => assert.fail('Retain existing analysis');
  await runCli(h.options, h.deps);
  assert.equal(switched, true);
  assert.equal((await h.f.bridge.binding()).project_id, '2');
  assert.equal((await h.f.bridge.setup.analysis()).status, 'ready');
});

test('configure saves local model choices without account access and repeat init uses them', async t => {
  const h = await configuredCli(t, { available: ['claude', 'codex'] });
  const choices = ['claude', 'sonnet', 'low'];
  h.deps.ui.choose = async () => choices.shift();
  const status = h.session.status;
  h.session.status = async () => assert.fail('Local settings do not need account access');
  h.session.login = async () => assert.fail('Local settings do not need sign-in');
  h.f.bridge.api.request = async () => assert.fail('Local settings must not call the API');
  assert.deepEqual(await runCli({ ...h.options, command: 'configure' }, h.deps), { agent: 'claude', model: 'sonnet', effort: 'low' });
  assert.deepEqual(await h.f.ws.json('.rtfm/supportpages/setup/settings.json'), { agent: 'claude', models: { claude: { model: 'sonnet', effort: 'low' } } });
  h.session.status = status;
  h.session.login = async () => ({ status: 'signed_in', account, already_signed_in: true });
  h.f.bridge.api.request = async () => structuredClone(context);
  h.deps.ui.choose = async (question, choices, index) => {
    assert.ok(['Which coding agents should use SupportPages Writer in this project?', 'Claude Code model', 'Reasoning effort'].includes(question));
    return choices[index].value;
  };
  let launched;
  h.deps.openAgent = async value => { launched = value; return true; };
  await runCli(h.options, h.deps);
  assert.equal(launched, undefined, 'init does not open the agent');
  // init leaves writing to the coding agent; the legacy write command carries the saved settings.
  await runCli({ ...h.options, command: 'write' }, h.deps);
  assert.equal(launched.agent, 'claude'); assert.equal(launched.model, 'sonnet'); assert.equal(launched.effort, 'low');
});

test('configure preserves other agent settings and cancellation does not partially save', async t => {
  const h = await configuredCli(t, { available: ['claude', 'codex'] });
  const settings = { agent: 'claude', models: { claude: { model: 'opus', effort: 'high' } } };
  await h.f.ws.writeJson('.rtfm/supportpages/setup/settings.json', settings);
  const choices = ['codex', 'custom', 'medium'];
  h.deps.ui.choose = async () => choices.shift();
  h.deps.ui.ask = async (_q, _initial, { validate }) => {
    assert.ok(validate('--flag')); assert.equal(validate('custom-model'), undefined); return 'custom-model';
  };
  await runCli({ ...h.options, command: 'configure' }, h.deps);
  const saved = await h.f.ws.json('.rtfm/supportpages/setup/settings.json');
  assert.deepEqual(saved, { agent: 'codex', models: { ...settings.models, codex: { model: 'custom-model', effort: 'medium' } } });
  choices.push('claude', 'sonnet');
  h.deps.ui.choose = async () => { if (!choices.length) throw new Cancelled(); return choices.shift(); };
  await assert.rejects(runCli({ ...h.options, command: 'configure' }, h.deps), Cancelled);
  assert.deepEqual(await h.f.ws.json('.rtfm/supportpages/setup/settings.json'), saved);
});

test('init stops after declined analysis without launching an agent or offering article actions', async t => {
  const h = await configuredCli(t);
  await rm(path.join(h.f.root, '.rtfm/supportpages/setup/analysis.json'));
  await rm(path.join(h.f.root, 'output/detect-project/summary.md'));
  h.deps.ui.confirm = async question => question !== 'Run the analysis now with Codex?' && !question.startsWith('Change the ');
  h.deps.ui.choose = async (question, choices, index) => {
    assert.ok(['Coding agent for this project', 'Codex model', 'Reasoning effort'].includes(question));
    return choices[index].value;
  };
  h.deps.runAgent = async () => assert.fail('Analysis must be approved first');
  await runCli(h.options, h.deps);
  assert.equal((await h.f.bridge.setup.analysis()).status, 'required');
  assert.doesNotMatch(h.logs.join('\n'), /Ready to write/);
  assert.equal((await h.f.bridge.binding()).project_id, '1');
});

test('init defaults the model from the harness catalogue and keeps it for writers and repeat init', async t => {
  for (const agent of ['codex', 'claude']) {
    const h = await configuredCli(t, { available: [agent] });
    let discoveries = 0, selections = 0, launched;
    h.deps.discoverModels = async (selectedAgent, options) => {
      assert.equal(selectedAgent, agent);
      assert.equal(options.cwd, h.f.root);
      discoveries++;
      return [
        { value: 'harness-default', label: 'Harness default', isDefault: true },
        { value: 'other-model', label: 'Another model', efforts: ['high'], defaultEffort: 'high' },
      ];
    };
    h.deps.ui.choose = async (question, choices, index) => {
      selections++;
      assert.ok(['Writing style', 'Run the analysis now?'].includes(question), question);
      return choices[index].value;
    };
    h.deps.openAgent = async value => { launched = value; return true; };
    await runCli(h.options, h.deps);
    await runCli(h.options, h.deps);
    // init leaves writing to the coding agent; the legacy write command carries the saved settings.
    await runCli({ ...h.options, command: 'write' }, h.deps);
    // Each init lists the models to name the current one; keeping it opens no picker.
    assert.equal(discoveries, 2);
    assert.equal(selections, 0);
    assert.equal(launched.model, 'harness-default');
    assert.equal(launched.effort, 'medium');
    const saved = await h.f.ws.json('.rtfm/supportpages/setup/settings.json');
    assert.deepEqual(saved.models[agent], { model: 'harness-default', effort: 'medium' });
    const prepared = await h.f.bridge.prepare({ title: 'Project model', article_type: 'how-to' });
    assert.equal(prepared.task_brief[agent === 'claude' ? 'claude_model' : 'codex_model'], 'harness-default');
    if (agent === 'codex') assert.equal(prepared.task_brief.codex_reasoning_effort, 'medium');
  }
});

test('a model chosen with configure is kept by later init runs', async t => {
  const h = await configuredCli(t, { available: ['codex'] });
  const choices = ['custom', 'high'];
  h.deps.ui.choose = async () => choices.shift();
  h.deps.ui.ask = async () => 'chosen-project-model';
  await runCli({ ...h.options, command: 'configure' }, h.deps);
  let discoveries = 0;
  const discovery = h.deps.discoverModels;
  h.deps.discoverModels = async (...args) => { discoveries++; return discovery(...args); };
  await runCli(h.options, h.deps);
  assert.equal(discoveries, 1, 'init lists models once to describe the saved one');
  assert.match(h.logs.join('\n'), /Codex will write this project’s articles with chosen-project-model at High effort\./);
  assert.deepEqual((await h.f.ws.json('.rtfm/supportpages/setup/settings.json')).models.codex, { model: 'chosen-project-model', effort: 'high' });
});

test('init with an explicit agent switches the analysis agent without asking, and setup owns agent selection', async t => {
  const h = await configuredCli(t, { available: ['claude', 'codex'] });
  const saved = { agent: 'claude', agents: ['claude', 'codex'], models: { claude: { model: 'sonnet', effort: 'low' }, codex: { model: 'test-codex', effort: 'low' } } };
  await h.f.ws.writeJson('.rtfm/supportpages/setup/settings.json', saved);
  let asked = 0;
  h.deps.ui.choose = async (question, choices, index) => { if (/coding agent/i.test(question)) asked++; return choices[index].value; };
  await runCli({ ...h.options, agent: 'codex' }, h.deps);
  assert.equal(asked, 0);
  const result = await h.f.ws.json('.rtfm/supportpages/setup/settings.json');
  assert.equal(result.agent, 'codex');
  assert.deepEqual(result.models.claude, saved.models.claude);
  // The computer-level setup is where the integration's agents are chosen.
  const setup = await configuredCli(t, { available: ['claude', 'codex'], local: true });
  setup.f.bridge.api.request = async () => ({ projects: [] });
  setup.deps.ui.choose = async (question, choices, index) => {
    if (question === 'How would you like to get started?') return 'local';
    if (/coding agents/i.test(question)) {
      assert.equal(question, 'Which coding agents should use SupportPages Writer?', 'setup is computer-wide');
      return 'both';
    }
    return choices[index].value;
  };
  await runCli({ ...setup.options, command: 'setup' }, setup.deps);
  assert.match(setup.logs.join('\n'), /Coding agent: Codex and Claude Code/);
});

test('project overrides are rejected by status before account access',async t=>{
  const h=await configuredCli(t);
  h.session.status=async()=>assert.fail('No account access for invalid options');
  await assert.rejects(runCli({...h.options,command:'status',project:'1'},h.deps),{code:'invalid_request'});
  assert.equal(h.prompts.length,0);
});

test('missing coding clients and system prerequisites stop before browser sign-in',async t=>{
  for(const missing of ['clients','git']) {
    const h=await configuredCli(t,{available:missing==='clients'?[]:['codex'],managed:false});
    h.session.status=async()=>assert.fail('No account access before prerequisites');
    h.session.login=async()=>assert.fail('No sign-in before prerequisites');
    const run=h.deps.run;
    h.deps.run=(cmd,args)=>cmd===missing?Promise.resolve({code:1}):run(cmd,args);
    await assert.rejects(runCli(h.options,h.deps),{code:'missing_dependency'});
    assert.ok(!h.logs.includes('Ready to write.'));
  }
});

test('a computer without the integration is set up during init, selecting a sole or multiple clients',async t=>{
  for(const available of [['codex'],['claude'],['codex','claude']]) {
    const h=await configuredCli(t,{available,managed:false});
    let selected, asked=false;
    h.deps.ui.choose=async(question,choices,index=0)=>{
      if(question==='How would you like to get started?') return 'local';
      if(/coding agents/i.test(question)) {
        asked=true; assert.equal(available.length,2); assert.deepEqual(choices.map(c=>c.value),['codex','claude','both']); return 'both';
      }
      return choices[index].value;
    };
    h.deps.install=async options=>{selected=options.client;assert.equal(options.embedded,true);return {skillsDir:h.skills};};
    await runCli(h.options,h.deps);
    assert.equal(asked,available.length===2);
    assert.equal(selected,available.length===1?available[0]:'both');
    assert.match(h.logs.join('\n'),/This computer is not set up for SupportPages Writer yet/);
    assert.match(h.logs.join('\n'),/Ready to write/);
  }
  const h=await configuredCli(t,{managed:false});
  h.deps.ui.choose=async question=>question==='How would you like to get started?'?'local':question;
  h.deps.install=async()=>{throw Error('download failed');};
  h.session.status=async()=>assert.fail('No account access after installation failure');
  h.session.login=async()=>assert.fail('No sign-in after installation failure');
  await assert.rejects(runCli(h.options,h.deps),{code:'installation_incomplete',message:/rerun supportpages init to retry/});
  // The same failure during setup sends the user back to setup.
  const setup=await configuredCli(t,{managed:false});
  setup.deps.ui.choose=async question=>question==='How would you like to get started?'?'local':question;
  setup.deps.install=async()=>{throw Error('download failed');};
  await assert.rejects(runCli({...setup.options,command:'setup'},setup.deps),{code:'installation_incomplete',message:/rerun supportpages setup to retry/});
});

test('init with an explicit Codex selection adds Codex to an existing Claude integration', async t => {
  const h = await configuredCli(t, { available: ['claude', 'codex'] });
  await writeFile(path.join(h.configDir, 'installations/supportpages.json'), JSON.stringify({ clients: ['claude'] }));
  let installed;
  h.deps.install = async options => { installed = options.client; return { skillsDir: h.skills }; };
  h.deps.ui.choose = async (question, choices, index) => {
    assert.ok(['Coding agent for this project', 'Codex model', 'Reasoning effort'].includes(question));
    return choices[index].value;
  };
  await runCli({ ...h.options, agent: 'codex' }, h.deps);
  assert.equal(installed, 'codex');
});

test('a folder nobody has set up is not reported as a sign-in problem, and hosting is offered on its merits', async t => {
  const f = await fixture(t); const configDir = path.join(f.root, 'config');
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => assert.fail('an unconfigured folder must not call the service');
  t.after(() => { globalThis.fetch = previousFetch; });
  for (const command of ['status', 'doctor']) {
    const logs = [];
    await runCli({ command, workspace: f.root, 'config-dir': configDir, 'api-url': origin }, { installRoot: path.resolve('.'), ui: { line: s => logs.push(s) }, run: async () => ({ code: 1 }), env: { SUPPORTPAGES_API_URL: undefined, SUPPORTPAGES_DEV: undefined } });
    const output = logs.join('\n');
    // The headline promise is that writing articles needs no account. Neither
    // read-only command may contradict it before the user has chosen anything.
    assert.doesNotMatch(output, /authentication[ _]required/i, `${command} must not report an authentication failure`);
    assert.doesNotMatch(output, /supportpages login/, `${command} must not push sign-in as the next step`);
    assert.match(output, /no account/i);
    assert.match(output, /supportpages init/);
  }
});

test('the setup invitation promises only what the post-article reminders promise', async t => {
  const lines = setupInvitation().join(' ');
  assert.match(lines, /free/);
  // Composed from the shared catalogue, so the two copy sets cannot drift.
  for (const id of ['public_url', 'editor_review', 'ai_answers', 'free_account']) {
    const benefit = hostingBenefits.find(item => item.id === id);
    assert.ok(benefit.short, `${id} must carry the short form the invitation composes`);
    assert.ok(lines.includes(benefit.short), `${id} must appear in the setup invitation`);
  }
});

test('status prints the signed-in account and a next step for unlinked folders', async t => {
  const f = await fixture(t); const configDir = path.join(f.root, 'config');
  await saveTokenFile(credentialLocation(origin, configDir).filename, origin, token, account);
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json(projects);
  t.after(() => { globalThis.fetch = previousFetch; });
  const logs = [];
  await runCli({ command: 'status', workspace: f.root, 'config-dir': configDir, 'api-url': origin }, { installRoot: path.resolve('.'), ui: { line: s => logs.push(s) }, run: async () => ({ code: 1 }), env: { SUPPORTPAGES_API_URL: undefined, SUPPORTPAGES_DEV: undefined } });
  assert.match(logs.join('\n'), /Destination not chosen/);
  assert.match(logs.join('\n'), /Signed in as alice@example.com/);
  // Even for a signed-in account, a help centre is one of two destinations.
  assert.match(logs.join('\n'), /Run supportpages init to choose where this folder’s articles go/);
  assert.match(logs.join('\n'), /saved in the project with no help centre/);
  assert.ok(!logs.join('\n').includes(token));
});

test('retired local planning commands return a project connection link without running an agent', async t => {
  const h = await configuredCli(t);
  const connect_url = 'https://app.supportpages.io/projects/example/repository_connection?source=completion';
  h.f.bridge.context = async () => ({ ...context, repository_connection: { connect_url } });
  h.deps.runAgent = async () => assert.fail('Retired commands must not start an agent');
  h.deps.openAgent = async () => assert.fail('Retired commands must not open an agent');
  for (const command of ['sections', 'recommend']) {
    await assert.rejects(runCli({ ...h.options, command }, h.deps), error => error.code === 'server_update_required' && error.details.writer_action.action === (command === 'sections' ? 'suggest_sections' : 'recommend_articles'));
  }
});

test('repeat init retires owned writer links without reinstalling the engine', async t => {
  for (const client of ['claude', 'codex']) {
    const h = await configuredCli(t, { available: [client] });
    h.deps.ui.choose = async (_question, choices, index = 0) => choices[index].value;
    const discovery = path.join(h.deps.home, client === 'claude' ? '.claude/skills' : '.agents/skills');
    await mkdir(discovery, { recursive: true });
    const link = path.join(discovery, 'generate-illustrated-article');
    await symlink(path.join(h.skills, 'generate-illustrated-article'), link);
    await runCli(h.options, h.deps);
    await assert.rejects(lstat(link), { code: 'ENOENT' });
    assert.equal(await readFile(path.join(h.skills, 'generate-illustrated-article/SKILL.md'), 'utf8'), 'test');
    assert.match(h.logs.join('\n'), /Restart existing coding-agent sessions/);
    h.logs.length = 0;
    await runCli(h.options, h.deps);
    assert.doesNotMatch(h.logs.join('\n'), /Removed old SupportPages.io skill shortcuts/);
  }
});

test('init configures both models and uses the selected analysis agent for CLI and host-specific MCP settings', async t => {
  const h = await configuredCli(t, { available: ['claude', 'codex'] });
  await rm(await h.f.ws.resolve('.rtfm/supportpages/setup/analysis.json'));
  await rm(await h.f.ws.resolve('output/detect-project/summary.md'));
  await mkdir(path.join(h.skills, 'detect-project'), { recursive: true });
  await writeFile(path.join(h.skills, 'detect-project/SKILL.md'), 'Detect this project.');
  let analysed;
  h.deps.runAgent = async options => {
    analysed = options;
    await writeFile(path.join(options.env.RTFM_OUTPUT_DIR, 'summary.md'), 'Project analysis.');
    await writeFile(path.join(options.env.RTFM_OUTPUT_DIR, 'overview.txt'), 'Helps users work together.');
  };
  const selections = [], discovered = [];
  let launched;
  h.deps.discoverModels = async agent => {
    discovered.push(agent);
    return [{ value: `${agent}-chosen`, label: 'Project model', isDefault: true, efforts: ['medium', 'high'], defaultEffort: 'high' }];
  };
  h.deps.ui.choose = async (question, options, index) => {
    selections.push(question);
    // The agents were chosen by computer setup; init only picks which one analyses.
    // Claude Code is listed first and preselected; accepting the default runs it now.
    if (question === 'Run the analysis now?') {
      assert.deepEqual(options.map(option => option.value), ['claude', 'codex', 'later']);
      assert.equal(options[0].hint, 'Recommended');
      return options[index].value;
    }
    assert.fail(question);
  };
  h.deps.openAgent = async options => { launched = options; return true; };
  await runCli(h.options, h.deps);
  assert.equal(analysed.agent, 'claude');
  assert.equal(analysed.model, 'claude-chosen');
  assert.equal(analysed.effort, 'medium');
  assert.deepEqual(discovered, ['codex', 'claude']);
  assert.deepEqual(selections, ['Run the analysis now?']);
  const saved = await h.f.ws.json('.rtfm/supportpages/setup/settings.json');
  assert.deepEqual(saved.agents, ['codex', 'claude']);
  assert.equal(saved.agent, 'claude');
  assert.deepEqual(saved.models, { codex: { model: 'codex-chosen', effort: 'medium' }, claude: { model: 'claude-chosen', effort: 'medium' } });
  // init leaves writing to the coding agent; the legacy write command carries the saved settings.
  await runCli({ ...h.options, command: 'write' }, h.deps);
  assert.equal(launched.agent, 'claude');
  assert.equal(launched.model, 'claude-chosen');
  await runCli({ ...h.options, command: 'write', agent: 'codex' }, h.deps);
  assert.equal(launched.agent, 'codex');
  assert.equal(launched.model, 'codex-chosen');
  await runCli({ ...h.options, command: 'write' }, h.deps);
  assert.equal(launched.agent, 'codex', 'later CLI runs remember the explicit override');
  const prepared = await h.f.bridge.prepare({ title: 'Both agents', article_type: 'how-to' });
  assert.equal(prepared.task_brief.claude_model, 'claude-chosen');
  assert.equal(prepared.task_brief.codex_model, 'codex-chosen');
  assert.equal(prepared.task_brief.codex_reasoning_effort, 'medium');
});

test('setting up a second coding agent preserves existing model defaults', async t => {
  const h = await configuredCli(t, { available: ['claude', 'codex'] });
  await writeFile(path.join(h.configDir, 'installations/supportpages.json'), JSON.stringify({ clients: ['claude'] }));
  await h.f.ws.writeJson('.rtfm/supportpages/setup/settings.json', { agent: 'claude', agents: ['claude'], models: { claude: { model: 'opus', effort: 'high' } } });
  let installed;
  h.deps.install = async options => { installed = options.client; await writeFile(path.join(h.configDir, 'installations/supportpages.json'), JSON.stringify({ clients: ['claude', 'codex'] })); return { skillsDir: h.skills }; };
  h.deps.ui.choose = async (question, options, index) => {
    if (/coding agents/i.test(question)) { assert.equal(options[index].value, 'claude'); return 'both'; }
    if (question === 'How would you like to get started?') return 'local';
    return options[index].value;
  };
  await runCli({ ...h.options, command: 'setup' }, h.deps);
  assert.equal(installed, 'both');
  await runCli(h.options, h.deps);
  const saved = await h.f.ws.json('.rtfm/supportpages/setup/settings.json');
  assert.deepEqual(saved.agents, ['codex', 'claude']);
  assert.deepEqual(saved.models.claude, { model: 'opus', effort: 'high' });
  assert.ok(saved.models.codex);
});

test('cancelling the agent choice or the help-centre confirmation leaves all saved models intact', async t => {
  const file = '.rtfm/supportpages/setup/settings.json';
  const saved = { agent: 'claude', agents: ['claude', 'codex'], models: { claude: { model: 'opus', effort: 'high' }, codex: { model: 'test-codex', effort: 'low' } }, unrelated: 'kept' };
  // Cancelling the computer-level agent choice.
  {
    const h = await configuredCli(t, { available: ['claude', 'codex'] });
    await h.f.ws.writeJson(file, saved);
    await writeFile(path.join(h.configDir, 'installations/supportpages.json'), JSON.stringify({ clients: ['claude'] }));
    h.deps.ui.choose = async (question, options, index) => {
      if (/coding agents/i.test(question)) throw new Cancelled();
      if (question === 'How would you like to get started?') return 'local';
      return options[index].value;
    };
    h.deps.openAgent = async () => assert.fail('Cancelled setup must not launch an agent');
    await assert.rejects(runCli({ ...h.options, command: 'setup' }, h.deps), Cancelled);
    assert.deepEqual(await h.f.ws.json(file), saved);
  }
  // Cancelling project setup at the existing-help-centre confirmation.
  {
    const h = await configuredCli(t, { available: ['claude', 'codex'] });
    await h.f.ws.writeJson(file, saved);
    h.deps.ui.confirm = async question => { if (question === 'Keep publishing to this help centre?') throw new Cancelled(); return true; };
    h.deps.openAgent = async () => assert.fail('Cancelled setup must not launch an agent');
    await assert.rejects(runCli(h.options, h.deps), Cancelled);
    assert.deepEqual(await h.f.ws.json(file), saved);
  }
});

test('configure offers an installed but unconnected coding agent and connects it on choice', async t => {
  // Codex is installed here, but only Claude Code was connected by setup.
  const h = await configuredCli(t, { available: ['claude', 'codex'] });
  await writeFile(path.join(h.configDir, 'installations/supportpages.json'), JSON.stringify({ clients: ['claude'] }));
  await h.f.ws.writeJson('.rtfm/supportpages/setup/settings.json', { agent: 'claude', agents: ['claude'], models: { claude: { model: 'opus', effort: 'high' } } });
  let installed;
  h.deps.install = async options => { installed = options.client; return { skillsDir: h.skills }; };
  h.deps.run = async (cmd, args) => {
    h.calls.push([cmd, args]);
    // `codex mcp get supportpages` fails until the integration is installed.
    if (cmd === 'codex' && args?.[0] === 'mcp') return { code: installed ? 0 : 1 };
    return { code: ['codex', 'claude', 'python3', 'jq', 'git'].includes(cmd) ? 0 : 1 };
  };
  const asked = [];
  h.deps.ui.choose = async (question, choices, index = 0) => {
    asked.push({ question, choices: choices.map(c => c.value) });
    if (question === 'What would you like to configure?') return 'agent';
    // Pressing Enter keeps the current agent; choosing Codex connects it.
    if (/Which coding agent should SupportPages Writer use/.test(question)) return 'codex';
    return choices[index].value;
  };
  await runCli({ ...h.options, command: 'configure' }, h.deps);
  const connection = asked.find(entry => /Which coding agent should SupportPages Writer use/.test(entry.question));
  assert.deepEqual(connection.choices, ['claude', 'codex']);
  assert.equal(installed, 'both');
  const saved = await h.f.ws.json('.rtfm/supportpages/setup/settings.json');
  assert.equal(saved.agent, 'codex');
  assert.deepEqual(saved.models.claude, { model: 'opus', effort: 'high' });
  assert.ok(saved.models.codex);
});

test('doctor says how to connect an installed but unregistered coding agent', async t => {
  const h = await configuredCli(t, { available: ['claude', 'codex'], managed: false });
  h.deps.run = async (cmd, args) => {
    h.calls.push([cmd, args]);
    if (args?.[0] === '--version') return { code: ['codex', 'claude'].includes(cmd) ? 0 : 1 };
    if (args?.[0] === 'mcp') return { code: cmd === 'codex' ? 1 : 0 };
    return { code: 1 };
  };
  h.session.status = async () => ({ status: 'project_required' });
  await runCli({ ...h.options, command: 'doctor' }, h.deps);
  const logs = h.logs.join('\n');
  assert.match(logs, /Codex is installed but not connected\. Run supportpages setup to connect it\./);
  assert.doesNotMatch(logs, /Claude Code is installed but not connected/);
});

test('configure asks for init on a folder that was never set up', async t => {
  const h = await configuredCli(t, { managed: false });
  await rm(await h.f.ws.resolve('.rtfm/supportpages/binding.json'));
  h.session.status = async () => assert.fail('configure must not read project status');
  await assert.rejects(runCli({ ...h.options, command: 'configure' }, h.deps), { code: 'project_required', message: /Run supportpages init/ });
});

test('init states the model and changes it only when asked, reusing the listed models', async t => {
  const h = await configuredCli(t, { available: ['codex'] });
  let discoveries = 0;
  h.deps.discoverModels = async () => { discoveries++; return [
    { value: 'gpt-6-astra', label: 'GPT-6-Astra', isDefault: true, efforts: ['low', 'medium', 'high'] },
    { value: 'gpt-6-sol', label: 'GPT-6-Sol', efforts: ['low', 'medium', 'high'] },
  ]; };
  h.deps.ui.confirm = async question => { h.prompts.push(question); return question === 'Change the Codex model?' || !question.startsWith('Change the '); };
  h.deps.ui.choose = async (question, choices, index) =>
    question === 'Codex model' ? 'gpt-6-astra' : question === 'Reasoning effort' ? 'high' : choices[index].value;
  await runCli(h.options, h.deps);
  assert.match(h.logs.join('\n'), /Codex will write this project’s articles with GPT-6-Sol at Medium effort\./);
  assert.ok(h.prompts.includes('Change the Codex model?'));
  assert.equal(discoveries, 1, 'the picker reuses the list init already fetched');
  assert.deepEqual((await h.f.ws.json('.rtfm/supportpages/setup/settings.json')).models.codex, { model: 'gpt-6-astra', effort: 'high' });
});

test('with both agents, choosing Later defers analysis without running an agent or calling the project ready', async t => {
  const h = await configuredCli(t, { available: ['codex', 'claude'] });
  await rm(path.join(h.f.root, '.rtfm/supportpages/setup/analysis.json'));
  await rm(path.join(h.f.root, 'output/detect-project/summary.md'));
  const questions = [];
  h.deps.ui.choose = async (question, choices, index) => {
    questions.push(question);
    return question === 'Run the analysis now?' ? 'later' : choices[index].value;
  };
  h.deps.runAgent = async () => assert.fail('Later must not start an agent');
  await runCli(h.options, h.deps);
  assert.ok(questions.includes('Run the analysis now?'));
  assert.equal((await h.f.bridge.setup.analysis()).status, 'required');
  const logs = h.logs.join('\n');
  assert.doesNotMatch(logs, /Ready to write|Articles {2}/);
});
