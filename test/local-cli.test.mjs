import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { repository, runCli, validExportDir, retryCommand } from '../scripts/lib/cli.mjs';
import { Planning } from '../scripts/lib/planning.mjs';
import { Cancelled } from '../scripts/lib/terminal.mjs';
import { fixture, seedAnalysis, article, png, remote, context } from './helpers.mjs';
import { ApiClient } from '../dist/api.js';
import { HostingReminders } from '../dist/hosting-benefits.js';

const origin = 'https://app.supportpages.io';
const account = { id: '10', email: 'alice@example.com' };

/** runCli harness for a folder with the integration installed but no help centre and no credential. */
async function localCli(t, { available = ['codex'], local } = {}) {
  const f = await fixture(t), configDir = path.join(f.root, 'config'), skills = path.join(f.root, 'skills');
  await mkdir(path.join(skills, 'generate-illustrated-article'), { recursive: true });
  await writeFile(path.join(skills, 'generate-illustrated-article/SKILL.md'), 'test');
  await mkdir(path.join(configDir, 'installations'), { recursive: true });
  await writeFile(path.join(configDir, 'installations/supportpages.json'), JSON.stringify({ clients: available }));
  await writeFile(path.join(configDir, 'installations/supportpages.mcp.json'), JSON.stringify({ mcpServers: { supportpages: { args: ['--api-url', origin, '--skills-dir', skills] } } }));
  await seedAnalysis(f.ws);
  f.bridge.api = new ApiClient(origin, undefined, async url => assert.fail(`Local folders must not call the API: ${url}`));
  if (local) await f.bridge.saveLocal({ version: 1, export_dir: 'output/articles', ...local });
  const logs = [], prompts = [], calls = [], answers = {};
  const session = { options: {}, bridge: async () => f.bridge, workspace: async () => f.ws,
    login: async () => assert.fail('Local folders must not sign in'), account: async () => undefined,
    status: async () => ({ account: undefined, ...(await f.bridge.status()) }), close: () => {} };
  const deps = { discoverModels: async () => [{ value: 'test-codex', label: 'Test Codex', isDefault: true }], home: path.join(f.root, 'home'),
    installCodex: async () => {}, installRoot: path.resolve('.'), env: { SUPPORTPAGES_API_URL: undefined, SUPPORTPAGES_DEV: undefined },
    sessionFactory: options => { session.options = options; return session; },
    run: async (cmd, args) => { calls.push([cmd, args]); return { code: ['codex', 'claude'].includes(cmd) && !available.includes(cmd) ? 1 : 0 }; },
    ui: { line: value => logs.push(value), ok: value => logs.push(value), info: value => logs.push(value), note: (value, title) => logs.push(`${title}: ${value}`), outro: value => logs.push(value),
      confirm: async question => { prompts.push(question); return answers[question] ?? true; },
      ask: async (label, fallback) => { prompts.push(label); return answers[label] ?? fallback; },
      choose: async (question, choices, index = 0) => { prompts.push(question); return answers[question] ?? choices[index].value; },
      multiselect: async (question, choices, defaults) => { prompts.push(question); return answers[question] ?? defaults; } },
    openAgent: async value => { calls.push(['open', value]); return true; },
    install: async () => assert.fail('Healthy integration must be reused') };
  return { f, configDir, skills, logs, prompts, calls, answers, session, deps, options: { command: 'init', workspace: f.root, 'config-dir': configDir, 'skills-dir': skills } };
}

test('init can save articles in the project without any sign-in, then write opens the agent with local instructions', async t => {
  const h = await localCli(t);
  h.answers['Where should finished articles go?'] = 'local';
  h.answers['Writing style'] = 'technical';
  h.answers['Folder for finished articles'] = 'docs/help/';
  const result = await runCli(h.options, h.deps);
  assert.equal(result.status, 'local'); assert.equal(result.export_dir, 'docs/help');
  assert.deepEqual(await h.f.ws.json('.rtfm/supportpages/local.json'), { version: 1, export_dir: 'docs/help', writing_style: 'technical' });
  assert.equal(await h.f.ws.exists('.rtfm/supportpages/binding.json'), false);
  assert.ok(h.prompts.includes('Where should finished articles go?'));
  assert.ok(!h.prompts.some(prompt => /help centre/i.test(prompt) && !/finished articles/.test(prompt)));
  // The choice is informed: what a help centre adds is stated before it is made.
  assert.match(h.logs.join('\n'), /public URL, editor review links and publishing from your agent/);
  assert.match(h.logs.join('\n'), /nothing leaves your computer/);
  assert.match(h.logs.join('\n'), /Articles will be saved in docs\/help/);
  assert.match(h.logs.join('\n'), /supportpages publish/);
  assert.equal(h.calls.find(call => call[0] === 'open'), undefined, 'init points to the coding agent instead of opening it');
  assert.match(h.logs.join('\n'), /Open Codex in this project and ask for an article/);
  assert.ok(await h.f.ws.exists(path.join(h.configDir.replace(h.f.root + '/', ''), 'workspaces')));
  // A later write and status work without an account.
  h.calls.length = 0;
  await runCli({ ...h.options, command: 'write' }, h.deps);
  assert.match(h.calls.find(call => call[0] === 'open')[1].prompt, /show where the article was saved/);
  h.logs.length = 0;
  await runCli({ ...h.options, command: 'status' }, h.deps);
  assert.match(h.logs.join('\n'), /Local articles/);
  assert.match(h.logs.join('\n'), /saved in docs\/help/);
  assert.match(h.logs.join('\n'), /supportpages publish/);
});

test('repeat init on a local folder keeps it local by default, and the default folder is the output directory', async t => {
  const h = await localCli(t, { local: { writing_style: 'minimal' } });
  await runCli(h.options, h.deps);
  assert.ok(h.prompts.includes('Keep saving articles in this project?'));
  assert.ok(!h.prompts.includes('Where should finished articles go?'));
  assert.ok(!h.prompts.includes('Writing style'));
  assert.deepEqual(await h.f.ws.json('.rtfm/supportpages/local.json'), { version: 1, export_dir: 'output/articles', writing_style: 'minimal' });
  const fresh = await localCli(t);
  fresh.answers['Where should finished articles go?'] = 'local';
  await runCli(fresh.options, fresh.deps);
  assert.deepEqual(await fresh.f.ws.json('.rtfm/supportpages/local.json'), { version: 1, export_dir: 'output/articles', writing_style: 'friendly' });
  assert.equal(validExportDir('docs/help/'), 'docs/help');
  for (const bad of ['', '/tmp', '../up', 'docs/../x', '~/docs', 'a\\b']) assert.equal(validExportDir(bad), undefined);
});

test('the hosted choice and an explicit project both go to sign-in; declining to keep local also reaches sign-in', async t => {
  for (const setup of [{ answers: {} }, { options: { project: '1' } }, { local: {}, answers: { 'Keep saving articles in this project?': false } }]) {
    const h = await localCli(t, { local: setup.local });
    Object.assign(h.answers, setup.answers ?? {});
    h.session.login = async () => { throw new Cancelled('sign-in reached'); };
    await assert.rejects(runCli({ ...h.options, ...setup.options }, h.deps), { message: 'sign-in reached' });
    assert.equal(h.prompts.includes('Where should finished articles go?'), !setup.options && !setup.local);
    assert.equal(await h.f.ws.exists('.rtfm/supportpages/local.json'), Boolean(setup.local));
  }
});

test('configure edits the local writing style, preferences and folder without sign-in; sync explains local folders', async t => {
  const h = await localCli(t, { local: {} });
  h.answers['What would you like to configure?'] = 'writing_style'; h.answers['Writing style'] = 'formal';
  await runCli({ ...h.options, command: 'configure' }, h.deps);
  assert.equal((await h.f.ws.json('.rtfm/supportpages/local.json')).writing_style, 'formal');
  h.answers['What would you like to configure?'] = 'preferences'; h.answers['Write articles in the background when available?'] = false;
  await runCli({ ...h.options, command: 'configure' }, h.deps);
  assert.deepEqual((await h.f.ws.json('.rtfm/supportpages/local.json')).preferences, { prefer_background: false, open_when_ready: true });
  h.answers['What would you like to configure?'] = 'export_dir'; h.answers['Folder for finished articles'] = 'docs';
  await runCli({ ...h.options, command: 'configure' }, h.deps);
  assert.equal((await h.f.ws.json('.rtfm/supportpages/local.json')).export_dir, 'docs');
  assert.ok(!h.prompts.includes('Repository connection reminders'));
  // Hosting reminders are a device preference: no account, no folder setting.
  h.answers['What would you like to configure?'] = 'hosting_reminders';
  h.answers['Show occasional reminders about hosting saved articles on SupportPages.io?'] = false;
  await runCli({ ...h.options, command: 'configure' }, h.deps);
  assert.match(h.logs.join('\n'), /Hosting reminders are off/);
  assert.equal((await new HostingReminders(h.configDir).preference(origin)).enabled, false);
  assert.equal((await h.f.ws.json('.rtfm/supportpages/local.json')).hosting_reminders, undefined);
  h.answers['Show occasional reminders about hosting saved articles on SupportPages.io?'] = true;
  await runCli({ ...h.options, command: 'configure' }, h.deps);
  assert.equal((await new HostingReminders(h.configDir).preference(origin)).enabled, true);
  await assert.rejects(runCli({ ...h.options, command: 'sync' }, h.deps), { code: 'local_workspace', message: /supportpages publish/ });
  await assert.rejects(runCli({ ...h.options, command: 'sections' }, h.deps), { code: 'authentication_required' });
});

test('repository discovery finds a local folder from a subdirectory, including dev state roots', async t => {
  const f = await fixture(t); await mkdir(path.join(f.root, 'src/deep'), { recursive: true });
  const run = async () => ({ code: 1 });
  assert.equal(await repository({ command: 'status' }, { cwd: path.join(f.root, 'src/deep'), run }), path.join(f.root, 'src/deep'));
  await f.ws.writeJson('.rtfm/supportpages/local.json', { version: 1, export_dir: 'output/articles' });
  assert.equal(await repository({ command: 'status' }, { cwd: path.join(f.root, 'src/deep'), run }), f.root);
  const dev = await fixture(t); await mkdir(path.join(dev.root, 'src'), { recursive: true });
  await dev.ws.writeJson('.rtfm/supportpages/dev/1234567890abcdef/local.json', { version: 1, export_dir: 'docs' });
  assert.equal(await repository({ command: 'status' }, { cwd: path.join(dev.root, 'src'), run }), dev.root);
});

test('publish signs in, connects a help centre and uploads the selected local articles in order, stopping at the plan limit', async t => {
  const h = await localCli(t, { local: { writing_style: 'minimal' } });
  for (const title of ['Alpha guide', 'Beta guide', 'Gamma guide']) {
    const prepared = await h.f.bridge.prepare({ title, article_type: 'how-to' });
    await h.f.ws.writeJson(`${prepared.artifact_dir}/article.json`, { ...article, title });
    await h.f.ws.write(`${prepared.artifact_dir}/block_invite.png`, png);
    await h.f.ws.writeJson(`${prepared.artifact_dir}/lint_report.json`, { all_passed: true });
    await h.f.bridge.complete({ run_id: prepared.run_id, completed: true });
  }
  const uploads = [];
  const api = new ApiClient(origin, 'sp_local_' + 'b'.repeat(64), async (url, init) => {
    if (url.endsWith('/mcp/settings')) return Response.json({ account, preferences: { prefer_background: true, open_when_ready: false }, writing_styles: { friendly: 'Friendly', minimal: 'Minimal' }, can_create_project: true });
    if (url.endsWith('/projects') && init.method === 'GET') return Response.json({ projects: [{ id: '1', name: 'Example', help_centre_url: 'https://example.supportpages.io' }] });
    if (url.endsWith('/projects/1') && init.method === 'PATCH') return Response.json({ project: { id: '1', name: 'Example', writing_style: JSON.parse(init.body).writing_style } });
    if (url.endsWith('/context')) return Response.json({ ...context, article_sync: true });
    if (url.includes('/sync')) return Response.json({ project_id: '1', through_id: '0', next_cursor: null, articles: [] });
    if (url.endsWith('/article_imports')) {
      const title = JSON.parse(await init.body.get('article').text()).title;
      uploads.push(title);
      if (uploads.length === 3) return Response.json({ error: { code: 'plan_limit', details: { article_capacity: { used: 2, limit: 2, can_create: false, upgrade_url: 'https://app.supportpages.io/billing', manage_articles_url: 'https://app.supportpages.io/projects' } } } }, { status: 403 });
      return Response.json({ import_id: String(uploads.length), article: { ...remote, id: String(uploads.length), editor_url: `https://app.supportpages.io/projects/example?article=${uploads.length}` } });
    }
    assert.fail(`Unexpected request ${init.method} ${url}`);
  });
  h.session.login = async ({ onApproval }) => { h.calls.push(['login']); h.f.bridge.api = api; h.session.account = async () => account; return { status: 'signed_in', api_origin: origin, account }; };
  h.session.status = async () => ({ account, ...(await h.f.bridge.status()) });
  h.answers['How would you like to sign in?'] = 'signup';
  const result = await runCli({ ...h.options, command: 'publish' }, h.deps);
  assert.ok(h.calls.some(call => call[0] === 'login'));
  assert.ok(h.prompts.includes('Choose a help centre'));
  assert.equal(h.prompts.includes('Where should finished articles go?'), false);
  assert.ok(h.prompts.includes('Which articles should be uploaded as drafts?'));
  assert.deepEqual(uploads, ['Alpha guide', 'Beta guide', 'Gamma guide']);
  assert.deepEqual(result.uploaded.map(item => item.title), ['Alpha guide', 'Beta guide']);
  assert.match(h.logs.join('\n'), /Alpha guide · https:\/\/app\.supportpages\.io\/projects\/example\?article=1/);
  assert.match(h.logs.join('\n'), /Gamma guide: .*article hosting slots/);
  assert.match(h.logs.join('\n'), /run supportpages publish again/);
  assert.equal(await h.f.bridge.destination(), 'hosted');
  assert.equal((await h.f.ws.json('.rtfm/supportpages/articles/alpha-guide.json')).project_id, '1');
  assert.equal((await h.f.ws.json('.rtfm/supportpages/articles/gamma-guide.json')).project_id, undefined);
  assert.deepEqual((await h.f.bridge.localArticles()).map(item => item.title), ['Gamma guide']);
  // The leftover can be uploaded later without choosing a help centre again.
  uploads.length = 0; h.prompts.length = 0;
  const again = await runCli({ ...h.options, command: 'publish' }, h.deps);
  assert.deepEqual(uploads, ['Gamma guide']); assert.equal(again.uploaded.length, 1);
  assert.equal(h.prompts.includes('Choose a help centre'), false);
  assert.match(h.logs.join('\n'), /1 draft uploaded to Example/);
});

test('publish explains when there is nothing to publish and status shows the connected folder afterwards', async t => {
  const h = await localCli(t, { local: {} });
  await assert.rejects(runCli({ ...h.options, command: 'publish' }, h.deps), { code: 'nothing_to_publish', message: /Ask your coding agent to write one/ });
  const unset = await localCli(t);
  await assert.rejects(runCli({ ...unset.options, command: 'publish' }, unset.deps), { code: 'project_required' });
});

test('Planning uses the folder context for analysis and the local write prompt', async t => {
  const f = await fixture(t, async url => assert.fail(`no network: ${url}`));
  f.bridge.api = new ApiClient(origin, undefined, async url => assert.fail(`no network: ${url}`));
  await f.bridge.saveLocal({ version: 1, export_dir: 'docs', writing_style: 'formal' });
  await seedAnalysis(f.ws);
  const session = { bridge: async () => f.bridge, options: { skillsDir: path.join(f.root, 'skills'), origin, dev: false } };
  const planning = await new Planning(session, { agent: 'codex' }, { ui: {}, run: async () => ({ code: 0 }), env: {} }, ['codex']).initialize();
  assert.equal(planning.projectId, undefined);
  const ctx = await planning.context();
  assert.equal(ctx.local, true); assert.equal(ctx.project_name, path.basename(f.root)); assert.match(ctx.writing_style, /Voice: neutral/);
  assert.equal(ctx.project_overview, 'Helps people work together.');
});

test('real terminal completes a local init with no network, then the MCP session reports local readiness', async t => {
  const { spawnSync } = await import('node:child_process');
  const f = await fixture(t), configDir = path.join(f.root, 'config'), script = path.join(f.root, 'terminal-local-init.mjs');
  const skills = path.join(f.root, 'skills');
  await f.ws.write('skills/detect-project/SKILL.md', 'Write full analysis to RTFM_OUTPUT_DIR.');
  const agentScript = await f.ws.write('fake-analysis.cjs', `
    const fs=require('fs'),path=require('path');
    process.stdin.resume();process.stdin.on('end',()=>{
      const context=JSON.parse(fs.readFileSync(process.env.RTFM_CONTEXT_FILE,'utf8'));
      if(process.env.RTFM_ANALYZE!=='full' || context.local!==true || !context.writing_style.includes('terse')) process.exit(1);
      fs.mkdirSync('.rtfm',{recursive:true});
      fs.writeFileSync('.rtfm/branding.json',JSON.stringify({framework:'test'}));
      fs.writeFileSync('.rtfm/project_map.json',JSON.stringify({framework:'test',route_index:{home:{}}}));
      fs.writeFileSync('.rtfm/branding.css','body { color: black; }');
      fs.writeFileSync(path.join(process.env.RTFM_OUTPUT_DIR,'summary.md'),'A collaboration product.');
      fs.writeFileSync(path.join(process.env.RTFM_OUTPUT_DIR,'overview.txt'),'Helps teams work together.');
      console.log(JSON.stringify({type:'turn.completed'}));
    });
  `);
  await mkdir(path.join(skills, 'generate-illustrated-article'), { recursive: true });
  await writeFile(path.join(skills, 'generate-illustrated-article/SKILL.md'), 'test');
  await writeFile(script, `
import {runCli} from ${JSON.stringify(path.resolve('scripts/lib/cli.mjs'))};
import {createTerminal} from ${JSON.stringify(path.resolve('scripts/lib/terminal.mjs'))};
import {Session} from ${JSON.stringify(path.resolve('dist/session.js'))};
import {runAgent} from ${JSON.stringify(path.resolve('scripts/lib/agent-runner.mjs'))};
import {spawn} from 'node:child_process';
globalThis.fetch=async url=>{ throw Error('Local setup must not use the network: '+url); };
let opened;
await runCli({command:'init',workspace:${JSON.stringify(f.root)},'skills-dir':${JSON.stringify(skills)},'config-dir':${JSON.stringify(configDir)}},{installRoot:${JSON.stringify(path.resolve('.'))},ui:createTerminal(),discoverModels:async()=>[{value:'test-codex',label:'Test Codex',isDefault:true}],open:async()=>{throw Error('no browser');},openAgent:async value=>{opened=value;return true;},run:async cmd=>({code:cmd==='claude'?1:0}),runAgent:value=>runAgent({...value,spawnProcess:(_cmd,_args,settings)=>spawn(process.execPath,[${JSON.stringify(agentScript)}],settings)}),install:async()=>({skillsDir:${JSON.stringify(skills)},clients:['codex']}),env:{SUPPORTPAGES_API_URL:undefined,SUPPORTPAGES_DEV:undefined}});
if(opened) throw Error('init must point to the coding agent instead of opening it');
const session=new Session({workspace:${JSON.stringify(f.root)},cwd:${JSON.stringify(f.root)},origin:'https://app.supportpages.io',dev:false,configDir:${JSON.stringify(configDir)},skillsDir:''});
const status=await session.init({});
if(status.status!=='local' || !status.generation_ready) throw Error('MCP did not report local readiness: '+JSON.stringify(status));
session.close();
`);
  const python = `
import os,pty,select,subprocess,sys,time
master,slave=pty.openpty()
p=subprocess.Popen([sys.argv[1],sys.argv[2]],stdin=slave,stdout=slave,stderr=slave,env={**os.environ,'TERM':'dumb'})
os.close(slave)
buf=b''
prompts=[(b'This computer is not set up for SupportPages Writer yet.',b'y\\r'),(b'Add SupportPages Writer to',b'y\\r'),(b'How would you like to get started?',b'3\\r'),(b'Where should finished articles go?',b'2\\r'),(b'Writing style',b'2\\r'),(b'Folder for finished articles',b'docs/help\\r'),(b'Change the Codex model?',b'n\\r'),(b'Run the analysis now with Codex?',b'y\\r')]
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
    try: p.wait(timeout=2)
    except subprocess.TimeoutExpired:
        p.kill(); raise AssertionError('timed out at: '+buf.decode(errors='replace')[-1200:])
    assert p.returncode==0,buf.decode(errors='replace')
    assert cursor==len(prompts),buf.decode(errors='replace')
    assert b'Open Codex in this project and ask for an article' in buf,buf.decode(errors='replace')
    assert b'Articles will be saved in docs/help' in buf,buf.decode(errors='replace')
    assert b'Choose a help centre' not in buf,buf.decode(errors='replace')
    assert b'This project is ready' in buf,buf.decode(errors='replace')
finally:
    if p.poll() is None: p.kill()
    os.close(master)
`;
  const result = spawnSync('python3', ['-c', python, process.execPath, script], { encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await f.ws.json('.rtfm/supportpages/local.json'), { version: 1, export_dir: 'docs/help', writing_style: 'minimal' });
  assert.equal(await f.ws.exists(path.relative(f.root, path.join(configDir, 'credentials'))), false);
});

test('after choosing local articles in setup, init preselects saving in the project', async t => {
  for (const [preset, expected] of [[{ version: 1, default_destination: 'local' }, 'local'], [{}, 'hosted']]) {
    const h = await localCli(t);
    await mkdir(h.configDir, { recursive: true });
    await writeFile(path.join(h.configDir, 'preferences.json'), JSON.stringify(preset));
    let preselected;
    const choose = h.deps.ui.choose;
    h.deps.ui.choose = async (question, choices, index) => {
      if (question === 'Where should finished articles go?') preselected = choices[index].value;
      return choose(question, choices, index);
    };
    h.session.login = async () => { throw new Cancelled('sign-in reached'); };
    if (expected === 'local') assert.equal((await runCli(h.options, h.deps)).status, 'local');
    else await assert.rejects(runCli(h.options, h.deps), { message: 'sign-in reached' });
    assert.equal(preselected, expected);
  }
});

test('analyse reuses the app type an incomplete project map asked for', async t => {
  const h = await localCli(t, { local: {} });
  // Seed a saved analysis whose map reported an incomplete detection.
  const map = await h.f.ws.json('.rtfm/project_map.json');
  await h.f.ws.writeJson('.rtfm/project_map.json', { ...map, detection_status: 'incomplete', app_type: 'web', app_type_source: 'default',
    detection_block: 'Source has no web layouts. Explicit app_type=terminal is required by the skill to select the terminal branch.' });
  await mkdir(path.join(h.skills, 'detect-project'), { recursive: true });
  await writeFile(path.join(h.skills, 'detect-project/SKILL.md'), 'Detect this project.');
  let prompt;
  h.deps.runAgent = async options => {
    prompt = options.prompt;
    const out = path.relative(h.f.root, options.env.RTFM_OUTPUT_DIR);
    // The rerun adopts the required app type and finishes its detection.
    await h.f.ws.writeJson('.rtfm/project_map.json', { ...map, app_type: 'terminal', app_type_source: 'hint', detection_status: 'complete', detection_block: null,
      command_index: { install: { definition_file: 'scripts/install.mjs', flags: [] } } });
    await h.f.ws.write(`${out}/summary.md`, 'A terminal product.');
    await h.f.ws.write(`${out}/overview.txt`, 'A CLI that installs things.');
  };
  h.deps.ui.confirm = async () => true;
  const result = await runCli({ ...h.options, command: 'analyse' }, h.deps);
  assert.match(h.logs.join('\n'), /asks for app_type=terminal/);
  assert.match(prompt, /Explicit app_type=terminal/);
  assert.equal(result.analysis.status, 'ready');
  assert.equal(result.analysis.app_type, 'terminal');
});

test('the write prompt allows a detection rerun but not the retired planning skills', async t => {
  const h = await localCli(t, { local: {} });
  await runCli({ ...h.options, command: 'write' }, h.deps);
  const prompt = h.calls.find(call => call[0] === 'open')[1].prompt;
  assert.match(prompt, /Do not run the retired planning skills \(suggest-sections, recommend-articles\)/);
  assert.match(prompt, /running detect-project again is allowed and required when the project map is missing, stale or reports an incomplete detection/);
});

test('init --refresh reruns detection, and a reused analysis says how to redo it', async t => {
  const h = await localCli(t, { local: {} });
  await mkdir(path.join(h.skills, 'detect-project'), { recursive: true });
  await writeFile(path.join(h.skills, 'detect-project/SKILL.md'), 'Detect this project.');
  let runs = 0;
  h.deps.runAgent = async options => {
    runs++;
    const out = path.relative(h.f.root, options.env.RTFM_OUTPUT_DIR);
    await h.f.ws.write(`${out}/summary.md`, 'A terminal product.');
    await h.f.ws.write(`${out}/overview.txt`, 'A CLI that installs things.');
  };
  h.deps.ui.confirm = async question => question !== 'Open Codex to write an article now?';
  // A ready analysis is reused, and the log says which one.
  h.logs.length = 0;
  await runCli(h.options, h.deps);
  assert.equal(runs, 0);
  assert.match(h.logs.join('\n'), /Using the project analysis from \d{4}-\d{2}-\d{2}\. Rerun with supportpages init --refresh to redo it\./);
  // --refresh runs detection again and does not claim to be reusing anything.
  h.logs.length = 0;
  await runCli({ ...h.options, refresh: true }, h.deps);
  assert.equal(runs, 1);
  assert.doesNotMatch(h.logs.join('\n'), /Using the project analysis from/);
  // The recovery command keeps the flags that were used.
  assert.equal(retryCommand({ refresh: true, 'app-type': 'terminal' }), "supportpages init --app-type 'terminal' --refresh");
});
