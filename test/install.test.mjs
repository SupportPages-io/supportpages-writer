import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdtemp, mkdir, readFile, realpath, writeFile, stat, chmod, symlink, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { SKILLS, exists, command, runInstaller, privateJson, registration, serverName } from '../scripts/lib/install.mjs';
import { retireManagedAnchor } from '../scripts/lib/article-skills.mjs';
import { readTokenFile } from '../dist/credentials.js';

const token = 'sp_local_' + 'a'.repeat(64);
const origin = 'https://app.supportpages.io';
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'supportpages-installer-'));
  t.after(() => rm(root, {recursive:true,force:true}));
  const home = path.join(root, 'home'), workspace=path.join(root,'product with spaces'), skills=path.join(root,'skills');
  await mkdir(home);await mkdir(workspace);await mkdir(skills);
  for(const skill of SKILLS) { await mkdir(path.join(skills,skill));await writeFile(path.join(skills,skill,'SKILL.md'),'fixture'); }
  await writeFile(path.join(skills,'install.sh'),'#!/bin/bash\nexit 0\n');
  await writeFile(path.join(skills,'VERSION'),'1.46.0');
  const logs=[],calls=[];
  const ui={line:s=>logs.push(s),step:(n,s)=>logs.push(`${n}. ${s}`),ok:s=>logs.push(s),ask:async(_q,f)=>f,confirm:async()=>true,secret:async()=>token,choose:async(_q,o)=>o[0].value};
  const run=async(cmd,args,opts)=>{calls.push({cmd,args,opts});return {code:args[0]==='mcp'&&args[1]==='get'?1:0,stdout:'',stderr:''};};
  const config=path.join(home,'.config/supportpages');
  const options={workspace,client:'both','api-url':origin,'skills-dir':skills,'skip-dependencies':true,'config-dir':config,'data-dir':path.join(home,'data')};
  const fetcher=async(url,init)=>{
    assert.equal(init.headers.Authorization,`Bearer ${token}`);
    if(url.endsWith('/projects'))return Response.json({projects:[{id:'1',name:'Example'}]});
    return Response.json({project:{id:'1',name:'Example'},supported_bundle_versions:[1],sections:[],articles:[]});
  };
  return {root,home,workspace,skills,config,logs,calls,options,deps:{ui,run,home,installCodex:async options=>{calls.push({cmd:'codex-integration',args:[],options:{name:options.name,home:options.home}});},installRoot:path.resolve('.'),fetcher,env:{},connect:async options=>{calls.push({cmd:'connect',args:[],options});return {status:'ready'};}}};
}

test('installer-owned client entry is safely re-registered with a backup; unrelated entries are preserved',async t=>{
  const f=await fixture(t);f.deps.env={SUPPORTPAGES_API_TOKEN:token};
  const options={...f.options,yes:true,client:'codex','skip-skills':true};
  const first=await runInstaller(options,f.deps);
  await mkdir(path.join(f.home,'.codex'));
  await writeFile(path.join(f.home,'.codex/config.toml'),'# unrelated settings\nmodel = "example"\n');
  f.deps.run=async(cmd,args,opts)=>{f.calls.push({cmd,args,opts});return {code:0,stdout:'',stderr:''};};
  await runInstaller(options,f.deps);
  assert.equal(await readFile(path.join(f.home,'.codex/config.toml'),'utf8'),'# unrelated settings\nmodel = "example"\n');
  assert.ok((await stat(path.join(f.config,'backups'))).isDirectory());
  await assert.rejects(runInstaller({...options,name:'another-server'},f.deps),/not created by this installer/);
  assert.ok(!f.calls.some(c=>c.args.includes('another-server')&&c.args.includes('add')));
  assert.equal(first.name, 'supportpages');
  assert.ok(f.calls.some(call => call.cmd === 'codex-integration' && call.options.name === 'supportpages'));
});

test('credentials reject the wrong origin, loose permissions and symlinks without exposing their value',async t=>{
  const f=await fixture(t), file=path.join(f.config,'credentials/token.json');
  await privateJson(file,{version:1,api_origin:origin,token});
  await assert.rejects(readTokenFile(file,'https://other.example'),e=>e.code==='invalid_credentials_file'&&!e.message.includes(token));
  await chmod(file,0o644);
  await assert.rejects(readTokenFile(file,origin),{code:'invalid_credentials_file'});
  await chmod(file,0o600);
  const link=path.join(f.config,'credentials/link.json');await symlink(file,link);
  await assert.rejects(readTokenFile(link,origin),{code:'invalid_credentials_file'});
  await assert.rejects(privateJson(link,{token:'replacement'}),/symlink/);
  assert.equal(await readTokenFile(file,origin),token);
});

test('the managed ~/.rtfm-skills link is retired; a separate checkout or real folder is kept',async t=>{
  const f=await fixture(t), data=path.join(f.home,'data'), anchor=path.join(f.home,'.rtfm-skills');
  await mkdir(path.join(data,'versions/0.1.16/mcp/skills'),{recursive:true});
  await symlink(path.join(data,'versions/0.1.16/mcp/skills'),anchor);
  assert.equal(await retireManagedAnchor({home:f.home,dataDir:data}),true);
  await assert.rejects(lstat(anchor),{code:'ENOENT'});
  await symlink(f.skills,anchor);
  assert.equal(await retireManagedAnchor({home:f.home,dataDir:data}),false);
  assert.ok((await lstat(anchor)).isSymbolicLink());
  await rm(anchor);await mkdir(anchor);
  assert.equal(await retireManagedAnchor({home:f.home,dataDir:data}),false);
  assert.ok((await lstat(anchor)).isDirectory());
});

test('article installation prepares the renderer, registers the Node trace hook and retires only owned public skill links', async t => {
  const f = await fixture(t);
  const discovery = path.join(f.home, '.agents/skills');
  await mkdir(discovery, { recursive: true });
  await symlink(path.join(f.skills, 'suggest-sections'), path.join(discovery, 'suggest-sections'));
  await symlink(path.join(f.skills, 'generate-illustrated-article'), path.join(discovery, 'generate-illustrated-article'));
  await mkdir(path.join(discovery, 'detect-project'));
  await symlink('/unrelated/custom/recommend-articles', path.join(discovery, 'recommend-articles'));
  for (const skill of SKILLS) await writeFile(path.join(f.skills, skill, 'package.json'), '{}');
  await runInstaller({ ...f.options, yes: true }, f.deps);
  await assert.rejects(lstat(path.join(discovery, 'suggest-sections')), { code: 'ENOENT' });
  await assert.rejects(lstat(path.join(discovery, 'generate-illustrated-article')), { code: 'ENOENT' });
  assert.ok((await lstat(path.join(discovery, 'detect-project'))).isDirectory());
  assert.equal(await readFile(path.join(f.skills, 'generate-illustrated-article/SKILL.md'), 'utf8'), 'fixture');
  assert.ok((await lstat(path.join(discovery, 'recommend-articles'))).isSymbolicLink());
  assert.ok(!f.calls.some(call => call.cmd === 'npm' && call.args.includes('install')), 'engine dependencies ship with the package');
  assert.ok(f.calls.some(call => call.cmd === process.execPath && call.args.some(arg => String(arg).includes('executablePath'))), 'Chromium is checked');
  assert.ok(!f.calls.some(call => call.cmd === 'bash' && call.args[0] === path.join(f.skills, 'install.sh')));
  const settings = JSON.parse(await readFile(path.join(f.home, '.claude/settings.json'), 'utf8'));
  assert.equal(settings.hooks.PostToolUse.length, 1);
  assert.equal(settings.hooks.PostToolUse[0].hooks[0].command, `'${process.execPath}' '${path.join(await realpath(f.skills), 'generate-illustrated-article/scripts/trace_hook.js')}'`);
  assert.deepEqual(settings.permissions.allow, ['mcp__supportpages']);
  assert.deepEqual(settings.permissions.ask, ['mcp__supportpages__supportpages_delete_article', 'mcp__supportpages__supportpages_unpublish_article']);
  assert.match(await readFile(path.join(f.home, '.claude/agents/supportpages-io.md'), 'utf8'), /name: supportpages-io/);
});

test('Claude integration repair installs the writer even when skills and dependency installation are skipped', async t => {
  const f = await fixture(t);
  const { workspace, ...options } = f.options;
  await mkdir(path.join(f.home, '.claude/skills'), { recursive: true });
  await symlink(path.join(f.skills, 'generate-illustrated-article'), path.join(f.home, '.claude/skills/generate-illustrated-article'));
  const result = await runInstaller({ ...options, yes: true, client: 'claude', dev: true, 'api-url': 'http://app.lvh.me:3000', 'skip-skills': true }, f.deps);
  assert.equal(result.name, 'supportpages-dev');
  await assert.rejects(lstat(path.join(f.home, '.claude/skills/generate-illustrated-article')), { code: 'ENOENT' });
  assert.deepEqual(JSON.parse(await readFile(path.join(f.home, '.claude/settings.json'), 'utf8')).permissions.allow, ['mcp__supportpages-dev']);
  assert.match(await readFile(path.join(f.home, '.claude/agents/supportpages-io.md'), 'utf8'), /name: supportpages-io/);
  assert.ok(!f.calls.some(call => ['npm', 'git', 'connect'].includes(call.cmd) && call.args[0] !== '--version'));
  const entry = JSON.parse(await readFile(result.manualPath, 'utf8')).mcpServers['supportpages-dev'];
  assert.equal(entry.args[0], path.resolve('dist/index.js'));
});

test('paths with spaces and shell syntax remain literal arguments; token env is stripped from child processes',async()=>{
  const args=['/tmp/checkout $(touch never)/dist/index.js','--workspace','/tmp/a b'];
  const result=registration('codex','supportpages-test',args,'/tmp/node with spaces');
  assert.deepEqual(result.args.slice(3),['--','/tmp/node with spaces',...args]);
  const probe=await command(process.execPath,['-e','process.stdout.write(String(process.env.SUPPORTPAGES_API_TOKEN === undefined))'],{capture:true,env:{...process.env,SUPPORTPAGES_API_TOKEN:token}});
  assert.equal(probe.stdout,'true');
  assert.notEqual(serverName('/tmp/one',origin),serverName('/tmp/two',origin));
});

test('an unmanaged Claude registration cannot receive a publish permission from a failed install', async t => {
  const f = await fixture(t);
  f.deps.run = async () => ({ code: 0, stdout: '', stderr: '' });
  await assert.rejects(runInstaller({ ...f.options, yes: true, client: 'claude', 'skip-skills': true }, f.deps), /not created by this installer/);
  assert.equal(await exists(path.join(f.home, '.claude/settings.json')), false);
});

test('shell installer help works without downloads; invalid token flags are not echoed',()=>{
  const help=spawnSync('bash',['install.sh','--help'],{encoding:'utf8'});
  assert.equal(help.status,0);
  assert.match(help.stdout,/guided local setup/);
  assert.doesNotMatch(help.stdout,/added \d+ packages/);
  const invalid=spawnSync('bash',['install.sh',`--token=${token}`],{encoding:'utf8'});
  assert.equal(invalid.status,2);
  assert.ok(!(invalid.stdout+invalid.stderr).includes(token));
});

test('a new install uses the bundled engine, downloads nothing and registers no public skills',async t=>{
  const f=await fixture(t);
  f.deps.installRoot=path.join(f.root,'mcp');
  await mkdir(f.deps.installRoot);
  await symlink(path.resolve('dist'),path.join(f.deps.installRoot,'dist'));
  await symlink(f.skills,path.join(f.deps.installRoot,'engine'));
  // An earlier release's managed shortcut is retired.
  await mkdir(path.join(f.home,'data/skills/v1.53.0'),{recursive:true});
  await symlink(path.join(f.home,'data/skills/v1.53.0'),path.join(f.home,'.rtfm-skills'));
  const {['skills-dir']:ignored,...options}=f.options;
  const result=await runInstaller({...options,yes:true,client:'manual','skip-token':true},f.deps);
  assert.equal(result.skillsDir, await realpath(path.join(f.deps.installRoot,'engine')), 'the bundled engine is the default');
  assert.ok(!f.calls.some(c=>c.cmd==='git'&&c.args[0]==='clone'), 'nothing is downloaded from GitHub');
  for (const skill of SKILLS) await assert.rejects(lstat(path.join(f.home, '.agents/skills', skill)), { code: 'ENOENT' });
  await assert.rejects(lstat(path.join(f.home, '.rtfm-skills')), { code: 'ENOENT' });
  assert.ok(!await exists(path.join(f.home, '.agents/skills/suggest-sections')));
});

test('a real terminal hides secret entry and cancellation never prints a partial token',()=>{
  const source = `
import os, pty, select, subprocess, sys, time
master, slave = pty.openpty()
code = "import {createTerminal} from './scripts/lib/terminal.mjs'; try {await createTerminal().secret('Paste token'); console.log('accepted');} catch { console.log('cancelled'); process.exitCode=130; }"
p = subprocess.Popen([sys.argv[1], '--input-type=module', '-e', code], stdin=slave, stdout=slave, stderr=slave, env={**os.environ, 'TERM': 'dumb'})
os.close(slave)
buf=b''
deadline=time.time()+5
try:
    while b'Paste token: ' not in buf and time.time()<deadline:
        if select.select([master],[],[],0.2)[0]: buf+=os.read(master,4096)
    assert b'Paste token: ' in buf, repr(buf)
    secret=b'sp_local_' + b'a'*64
    os.write(master,secret + (b'\\x03' if sys.argv[2]=='cancel' else b'\\r'))
    while time.time()<deadline:
        if select.select([master],[],[],0.1)[0]:
            try: buf+=os.read(master,4096)
            except OSError: break
        if p.poll() is not None: break
    p.wait(timeout=2)
    assert secret not in buf, 'Secret was echoed'
    assert b'aaaa' not in buf, 'Partial secret was echoed'
    assert (b'cancelled' if sys.argv[2]=='cancel' else b'accepted') in buf, repr(buf)
    assert p.returncode==(130 if sys.argv[2]=='cancel' else 0)
finally:
    if p.poll() is None: p.kill()
    os.close(master)
`;
  for (const mode of ['submit','cancel']) {
    const result=spawnSync('python3',['-c',source,process.execPath,mode],{encoding:'utf8',timeout:10000});
    assert.equal(result.status,0,result.stderr);
  }
});

test('server startup reads the saved credential and refuses an origin mismatch even with an inherited token',async t=>{
  const f=await fixture(t),file=path.join(f.config,'credentials/token.json');
  await privateJson(file,{version:1,api_origin:origin,token});
  const args=['dist/index.js','--workspace',f.workspace,'--skills-dir',f.skills,'--token-file',file,'--doctor'];
  const result=spawnSync(process.execPath,args,{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  assert.equal(JSON.parse(result.stdout).credentials_configured,true);
  assert.ok(!(result.stdout+result.stderr).includes(token));
  const wrong=spawnSync(process.execPath,[...args,'--api-url','https://other.example'],{encoding:'utf8',env:{...process.env,SUPPORTPAGES_API_TOKEN:token}});
  assert.equal(wrong.status,1);
  assert.equal(JSON.parse(wrong.stderr).code,'invalid_credentials_file');
  assert.ok(!(wrong.stdout+wrong.stderr).includes(token));
});


test('global installer never requests credentials or binds the install directory', async t => {
  const f = await fixture(t);
  f.deps.ui.secret = async () => { throw new Error('Must not request a token'); };
  f.deps.fetcher = async () => { throw new Error('Must not call the API'); };
  f.deps.env = { SUPPORTPAGES_API_TOKEN: token };
  const result = await runInstaller({ ...f.options, workspace: undefined, yes: true }, f.deps);
  assert.equal(result.name, 'supportpages');
  const manual = JSON.parse(await readFile(result.manualPath, 'utf8'));
  const args = manual.mcpServers.supportpages.args;
  assert.ok(!f.calls.some(c => c.cmd === 'connect'));
  assert.ok(!args.includes('--workspace'));
  assert.ok(!args.includes('--token-file'));
  assert.ok(!JSON.stringify([manual, f.logs, f.calls]).includes(token));
  assert.ok(f.calls.some(c => c.cmd === 'claude' && c.args.includes('user')));
  await assert.rejects(stat(path.join(f.config, 'credentials')), { code: 'ENOENT' });
  await assert.rejects(stat(path.join(f.workspace, '.rtfm')), { code: 'ENOENT' });
  const second = await runInstaller({ ...f.options, workspace: f.root, yes: true }, f.deps);
  assert.equal(second.name, result.name);
  assert.ok(!f.calls.some(c => c.cmd === 'connect'));
  assert.match(f.logs.join('\n'), /supportpages init inside each project folder/);
});

test('interactive installation never opens browser sign-in and points to init', async t => {
  const f = await fixture(t);
  const options = {...f.options, workspace:undefined};
  const questions = [];
  f.deps.ui.confirm = async question => { questions.push(question); return true; };
  await runInstaller(options, f.deps);
  assert.ok(!f.calls.some(c => c.cmd === 'connect'));
  assert.ok(!questions.some(question => /workspace|browser/i.test(question)));
  assert.match(f.logs.join('\n'), /Run supportpages setup once on this computer/);
  assert.match(f.logs.join('\n'), /then supportpages init inside each project folder/);
  await assert.rejects(stat(path.join(f.config, 'credentials')), { code: 'ENOENT' });
  const receipt = JSON.parse(await readFile(path.join(f.config,'installations/supportpages.json'),'utf8'));
  assert.deepEqual(receipt.clients,['codex','claude']);
});

test('global dev installation persists the environment without a workspace', async t => {
  const f = await fixture(t);
  const { ['api-url']: ignored, ...options } = f.options;
  const result = await runInstaller({ ...options, dev: true, yes: true }, f.deps);
  assert.equal(result.name, 'supportpages-dev');
  const manual = JSON.parse(await readFile(result.manualPath, 'utf8'));
  const args = manual.mcpServers[result.name].args;
  assert.ok(args.includes('--dev'));
  assert.ok(args.includes('https://app.lvh.me:3443'));
  assert.ok(!args.includes('--workspace'));
});

test('setup leaves Claude to an installed SupportPages Writer plugin instead of registering it twice', async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.home, '.claude/plugins'), { recursive: true });
  await writeFile(path.join(f.home, '.claude/plugins/installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'supportpages-writer@supportpages': [{ scope: 'user', version: '0.1.16' }] } }));
  const result = await runInstaller({ ...f.options, yes: true, client: 'both', 'skip-skills': true }, f.deps);
  assert.deepEqual(result.clients, ['codex']);
  assert.ok(!f.calls.some(call => call.cmd === 'claude' && call.args.includes('add')), 'no Claude MCP registration');
  assert.ok(f.logs.some(line => /already has the SupportPages Writer plugin/.test(line)));
});

test('inside setup and init the installer keeps paths, file names and permission rules out of the wizard', async t => {
  const f = await fixture(t);
  const codex = [];
  f.deps.installCodex = async options => { codex.push(options.announcePermission); };
  await runInstaller({ ...f.options, yes: true, embedded: true }, f.deps);
  const logs = f.logs.join('\n');
  assert.doesNotMatch(logs, /Using |permission|mcp__|\.md\b/);
  assert.match(logs, /^Added SupportPages Writer to Claude Code\.$/m);
  assert.ok(f.logs.every(line => !/^\s/.test(line)), 'no standalone-installer indentation');
  assert.deepEqual(codex, [false]);
  // The standalone installer still reports the details.
  const standalone = await fixture(t);
  await runInstaller({ ...standalone.options, yes: true }, standalone.deps);
  assert.match(standalone.logs.join('\n'), /Using .*skills/);
});
