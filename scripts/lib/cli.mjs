import { resolveAction, requireExecution } from '../../dist/actions.js';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { readFile, realpath, readdir } from 'node:fs/promises';
import { z } from 'zod';
import { Workspace } from '../../dist/workspace.js';
import { Session, defaultConfigDir } from '../../dist/session.js';
import { apiOrigin, defaultOrigin, developmentMode, connectionStateRoot } from '../../dist/api.js';
import { fail, publicError } from '../../dist/errors.js';
import { devicePreferences, saveDevicePreferences } from '../../dist/preferences.js';
import { configureTelemetry } from '../../dist/telemetry.js';
import { command, exists, expand, privateJson, runInstaller, backup, installationSkills } from './install.mjs';
import { claudePluginInstalled } from './claude-plugin.mjs';
import { Cancelled } from './terminal.mjs';
import { openBrowser } from './browser.mjs';
import { removeIntegration } from './remove.mjs';
import { uninitWorkspace } from './uninit.mjs';
import { ensureWriterAvailable } from './writer-recovery.mjs';
import { retirePublicSkillLinks } from './article-skills.mjs';
import { installClaudeWriter } from './claude-writer.mjs';
import { installClaudePermissions } from './claude-permissions.mjs';
import { installCodexIntegration } from './codex-integration.mjs';
import { configureAgent, confirmAgentModels, readAgentSettings, modelDescription } from './agent-settings.mjs';
import { Planning } from './planning.mjs';
import { selectClaudeConnection } from './claude-connection.mjs';
import { writingStylePresets, defaultWritingStyle } from '../../dist/writing-style.js';
import { setupInvitation } from '../../dist/hosting-benefits.js';
import { defaultPreferences } from '../../dist/settings.js';

const remoteId = z.string().regex(/^[1-9][0-9]*$/);
const settingsSchema = z.object({
  account:z.object({id:remoteId,email:z.string()}),
  preferences:z.object({prefer_background:z.boolean(),open_when_ready:z.boolean()}),
  writing_styles:z.record(z.string(),z.string()).default({}),
  can_create_project:z.boolean().default(false),
  project_creation_upgrade_url:z.url().refine(value=>{
    const url=new URL(value);
    return ['https:','http:'].includes(url.protocol) && !url.username && !url.password;
  }).nullish(),
});
const projectsSchema = z.object({projects:z.array(z.object({id:remoteId,name:z.string(),help_centre_url:z.url().optional()}))});
const createdSchema = z.object({project:z.object({id:remoteId,name:z.string(),subdomain:z.string()})});
const clean = value => String(value).replace(/[\p{Cc}\p{Cf}]/gu,'');
const parse = (schema, value) => { const result=schema.safeParse(value); if(!result.success) fail('invalid_response','SupportPages.io returned invalid setup data.'); return result.data; };
const profileFile = (configDir, root) => path.join(configDir,'workspaces',createHash('sha256').update(root).digest('hex')+'.json');

export async function repository(options, {cwd=process.cwd(),run=command,ui}={}) {
  if(options.workspace) return (await Workspace.create(expand(options.workspace))).root;
  const current=await realpath(cwd);
  const git=await run('git',['rev-parse','--show-toplevel'],{cwd:current,capture:true});
  const gitRoot=git.code===0 ? (await Workspace.create(git.stdout.trim())).root : undefined;
  const linked=async dir=>await exists(path.join(dir,'binding.json')) || await exists(path.join(dir,'local.json'));
  for(let cursor=current;;cursor=path.dirname(cursor)) {
    if(await linked(path.join(cursor,'.rtfm/supportpages'))) return cursor;
    const devDir=path.join(cursor,'.rtfm/supportpages/dev');
    if(await exists(devDir)) for(const name of await readdir(devDir)) {
      if(/^[a-f0-9]{16}$/.test(name) && await linked(path.join(devDir,name))) return cursor;
    }
    // A saved link in a container directory must not capture a child checkout
    // (including worktrees, whose .git is a file rather than a directory).
    if(cursor===gitRoot || cursor===path.dirname(cursor)) break;
  }
  return gitRoot ?? current;
}

export async function environment(root, options, env=process.env) {
  const configDir=expand(options['config-dir'] ?? defaultConfigDir());
  let saved;
  const file=profileFile(configDir,root);
  // Device authentication is independent of the current folder's saved connection.
  if(!['setup','login','logout'].includes(options.command) && await exists(file)) {
    try { saved=JSON.parse(await readFile(file,'utf8')); } catch { fail('invalid_configuration','The saved workspace environment is invalid.'); }
    if(saved?.version!==1 || saved.workspace!==root || typeof saved.dev!=='boolean' || typeof saved.origin!=='string') fail('invalid_configuration','The saved workspace environment is invalid.');
  }
  const dev=options.dev ?? (env.SUPPORTPAGES_DEV===undefined ? (options['api-url'] || env.SUPPORTPAGES_API_URL ? false : saved?.dev ?? false) : developmentMode(env.SUPPORTPAGES_DEV));
  const origin=apiOrigin(options['api-url'] ?? env.SUPPORTPAGES_API_URL ?? (options.dev!==undefined || env.SUPPORTPAGES_DEV!==undefined ? defaultOrigin(dev) : saved?.origin ?? defaultOrigin(dev)),dev);
  return {configDir,origin,dev};
}

async function installation(config, installRoot) {
  const filename=path.join(config.configDir,'installations',`${config.dev ? 'supportpages-dev' : 'supportpages'}.mcp.json`);
  if(!await exists(filename)) return;
  try {
    const value=JSON.parse(await readFile(filename,'utf8'));
    const entry=value.mcpServers[config.dev ? 'supportpages-dev' : 'supportpages'];
    const args=entry.args;
    const skills=args[args.indexOf('--skills-dir')+1];
    if(args.includes(config.origin) && typeof skills==='string') return {skills,filename};
  } catch { /* Doctor/init can repair incomplete registration. */ }
}

export async function generationChecks(skillsDir, run=command) {
  const results=await Promise.all(['git'].map(async name=>({name,available:(await run(name,['--version'],{capture:true})).code===0})));
  const articleDir=path.join(skillsDir,'generate-illustrated-article');
  results.push({name:'article skills',available:await exists(path.join(articleDir,'SKILL.md'))});
  const browser=await run(process.execPath,['--input-type=module','-e',"import {createRequire} from 'node:module'; import {accessSync} from 'node:fs'; const require=createRequire(process.argv[1]+'/package.json'); const p=require('puppeteer'); accessSync(await p.executablePath());",articleDir],{capture:true});
  results.push({name:'article renderer and Chromium',available:browser.code===0});
  return results;
}

async function ensureIntegration(config, options, deps, skillsDir, session, { clients: requestedClients } = {}) {
  const {ui,run,installRoot}=deps;
  // Setup and configure share this with init; retry advice names the command that was run.
  const retry=authCommand(['setup','configure'].includes(options.command) ? options.command : 'init',config);
  ui.info?.('Checking your coding agent and article renderer…');
  const receipt=path.join(config.configDir,'installations',`${config.dev ? 'supportpages-dev' : 'supportpages'}.json`);
  let clients=[];
  if(await exists(receipt)) { try { clients=JSON.parse(await readFile(receipt,'utf8')).clients ?? []; } catch {} }
  const available=[];
  for(const client of ['codex','claude']) if((await run(client,['--version'],{capture:true})).code===0) available.push(client);
  if(!available.length) fail('missing_dependency',`Install Codex or Claude Code and make its command available in this terminal, then rerun ${retry}. See https://supportpages.io/local.`);
  if(options.agent && !available.includes(options.agent)) fail('agent_unavailable',`Install ${options.agent==='codex'?'Codex':'Claude Code'} before selecting it for this project.`);
  const saved=await readAgentSettings({ws:await session.workspace(),stateRoot:connectionStateRoot(config.origin,config.dev)});
  const previous=saved.agents ?? (saved.agent ? [saved.agent] : clients);
  const preferred=previous.filter(client=>available.includes(client));
  const choices=available.map(value=>({value,label:value==='codex'?'Codex':'Claude Code'}));
  if(available.length>1) choices.push({value:'both',label:'Both',hint:'Configure a model for each agent'});
  const initial=preferred.length===2 ? 'both' : preferred[0];
  const client=options.agent ?? (requestedClients?.length===2 ? 'both' : requestedClients?.[0]) ?? (available.length===1 ? available[0] : await ui.choose(options.command==='setup' ? 'Which coding agents should use SupportPages Writer?' : 'Which coding agents should use SupportPages Writer in this project?',choices,Math.max(0,choices.findIndex(choice=>choice.value===initial))));
  const selectedClients=client==='both' ? available : [client];
  let installed=Boolean(await installation(config,installRoot));
  for(const selected of selectedClients) {
    const info=await run(selected,['mcp','get',config.dev ? 'supportpages-dev' : 'supportpages'],{capture:true});
    installed &&= clients.includes(selected) && info.code===0;
  }
  const checks=await generationChecks(skillsDir,run);
  if(installed && checks.every(item=>item.available)) {
    if (selectedClients.includes('claude')) {
      const agent = await installClaudeWriter({ home: deps.home ?? os.homedir(), env: deps.env });
      if (agent.changed) ui.line('Installed the SupportPages Writer agent for Claude Code. Restart existing Claude sessions to load it.');
      const permission = await installClaudePermissions({ home: deps.home ?? os.homedir(), env: deps.env,
        name: config.dev ? 'supportpages-dev' : 'supportpages', configDir: config.configDir, backup, writeJson: privateJson });
      if (permission.changed) ui.line("Allowed SupportPages Writer's tools in Claude Code; deleting or unpublishing an article still asks first.");
    }
    const registered = await installation(config, installRoot);
    if (selectedClients.includes('codex')) await (deps.installCodex ?? installCodexIntegration)({ home: deps.home ?? os.homedir(), env: deps.env,
      name: config.dev ? 'supportpages-dev' : 'supportpages', configDir: config.configDir, backup, ui });
    const removed = await retirePublicSkillLinks({ home: deps.home ?? os.homedir(), clients:selectedClients, directory: registered.skills, env: deps.env });
    if (removed.length) ui.line('Removed old SupportPages.io skill shortcuts. Restart existing coding-agent sessions to refresh their skill lists.');
    ui.ok('Your coding-agent integration and renderer are already installed.');
    return {skillsDir,clients:selectedClients,restartRequired:removed.length > 0};
  }
  const missing=checks.filter(item=>!item.available && item.name==='git');
  if(missing.length) fail('missing_dependency',`Install Git with your system package manager, then rerun ${retry}. See https://supportpages.io/local#prerequisites.`);
  ui.line(`Coding agent: ${clientList(selectedClients)}`);
  const download=checks.some(item=>!item.available && item.name==='article renderer and Chromium');
  if(download) ui.info?.('Article screenshots are taken in a browser that SupportPages Writer downloads once. The first download can take a few minutes.');
  if(!await ui.confirm(`Add SupportPages Writer to ${clientList(selectedClients)}${download ? ' and download the screenshot browser' : ''}?`,true)) throw new Cancelled();
  try {
    const result=await (deps.install ?? runInstaller)({client,dev:config.dev,'api-url':config.origin,'config-dir':config.configDir,
      'skills-dir':await exists(skillsDir) ? skillsDir : undefined,'skip-dependencies':true,embedded:true},deps);
    return {skillsDir:result.skillsDir,clients:selectedClients,restartRequired:true};
  } catch(error) {
    if(error instanceof Cancelled) throw error;
    if(/^(An existing directory or file would be replaced:|Missing |Could not register |This connection name is already|The skills checkout)/.test(error.message ?? '')) ui.line(clean(error.message));
    fail('installation_incomplete',`Coding-agent installation could not finish. Completed steps are kept. Run ${authCommand('doctor',config)}, then rerun ${retry} to retry.`);
  }
}

/** What each destination gives: the local choice is made by people who do not
 * know yet what an account adds, so the difference is stated where it is chosen. */
export const destinationNote='A help centre gives articles a public URL, editor review links and publishing from your agent. Saving locally keeps Markdown and screenshots in this project; nothing leaves your computer.';
export const getStartedChoices = [
  {value:'signin',label:'Sign in to my existing SupportPages.io account'},
  {value:'signup',label:'Create a free SupportPages.io account and help centre'},
  {value:'local',label:'Save articles in my projects without an account'},
];

/** Sign this device in once. A working saved credential is reused without a browser. */
export async function ensureLogin(session, {ui,open=openBrowser}, {publish=false,mode,scopes}={}) {
  let interrupted=false;
  const onInterrupt=()=>{interrupted=true;ui.cancel?.();session.close();};
  process.once('SIGINT',onInterrupt);
  const keepAlive=setInterval(()=>{},1000);
  try {
    const result=await session.login({publish,scopes,onApproval:async approval=>{
      const url=new URL(approval.url);
      if(mode==='signup') url.searchParams.set('signup','1');
      const action=mode==='signup' ? 'Create a free SupportPages.io account' : mode==='signin' ? 'Sign in to your SupportPages.io account' : 'Sign in or create an account';
      const instructions=`${action}, then approve sign-in for this device.\nCheck the code: ${approval.code}\n\n${url.href}\n\nReturn to this terminal after approving.`;
      if(ui.note) ui.note(instructions,'Continue in your browser');
      else {ui.line(instructions);}
      if(!await open(url.href)) ui.line('Open the link above to approve, then return here.');
      ui.info?.('Waiting for browser approval… Ctrl+C cancels sign-in.');
    }});
    if(interrupted) throw new Cancelled();
    if(!result.already_signed_in) ui.ok(`Signed in as ${clean(result.account?.email ?? 'your account')}.`);
    return result;
  } catch(error) {
    if(interrupted || error.code==='authorization_cancelled') throw new Cancelled();
    throw error;
  } finally {clearInterval(keepAlive);process.removeListener('SIGINT',onInterrupt);}
}

async function chooseWritingStyle(bridge, projectId, settings, ui, draft={}) {
  if(!Object.keys(settings.writing_styles).length) return;
  const context=await bridge.api.request('GET',`/projects/${projectId}/context`);
  const current=context?.product_context?.tone_preference;
  const normalized=typeof current==='string' ? current.trim().toLowerCase() : '';
  const descriptions={friendly:'Warm, everyday language',minimal:'Short explanations and easy-to-scan steps',technical:'Detailed explanations with precise terminology',formal:'Professional language with a more reserved tone'};
  const styles=Object.entries(settings.writing_styles).map(([value,label])=>({value,label:clean(label),hint:descriptions[value]}));
  if(normalized && !styles.some(style=>style.value===normalized)) styles.unshift({value:'keep',label:'Keep current custom style'});
  const initial=draft.writingStyle ?? (normalized && !settings.writing_styles[normalized] ? 'keep' : normalized || 'friendly');
  ui.line('Choose how your help articles should sound. This applies to the whole help centre, including articles written in the web app.');
  const style=await ui.choose('Writing style',styles,Math.max(0,styles.findIndex(item=>item.value===initial)));
  draft.writingStyle=style;
  if(style!=='keep') await bridge.api.request('PATCH',`/projects/${projectId}`,{writing_style:style});
  return styles.find(item=>item.value===style)?.label;
}

async function configurePreferences(bridge, ui) {
  const settings=parse(settingsSchema,await bridge.api.request('GET','/mcp/settings'));
  ui.line('Your preferences apply across all help centres.');
  const preferences={
    prefer_background:await ui.confirm('Write articles in the background when available?',settings.preferences.prefer_background),
    open_when_ready:await ui.confirm('Open completed drafts in your browser?',settings.preferences.open_when_ready),
  };
  await bridge.api.request('PATCH','/mcp/settings',{preferences});
}

/** Writing-style preset for a folder without a help centre; a custom style typed elsewhere is kept. */
async function chooseLocalWritingStyle(ui, current) {
  const styles=Object.entries(writingStylePresets).map(([value,{label,hint}])=>({value,label,hint}));
  const normalized=typeof current==='string' ? current.trim().toLowerCase() : '';
  if(normalized && !writingStylePresets[normalized]) styles.unshift({value:'keep',label:'Keep current custom style'});
  ui.line('Choose how your help articles should sound.');
  const initial=normalized ? (writingStylePresets[normalized] ? normalized : 'keep') : defaultWritingStyle;
  const style=await ui.choose('Writing style',styles,Math.max(0,styles.findIndex(item=>item.value===initial)));
  return style==='keep' ? current : style;
}
export const validExportDir = value => {
  const trimmed=String(value).trim().replace(/\/+$/,'');
  if(!trimmed || trimmed.length>500 || path.isAbsolute(trimmed) || trimmed.startsWith('~') || /[\p{Cc}\p{Cf}]/u.test(trimmed) || trimmed.includes('\\')) return;
  if(trimmed.split('/').some(part=>!part || part==='.' || part==='..')) return;
  return trimmed;
};
async function askExportDir(ui, current='output/articles') {
  ui.line('Finished articles are saved as index.md with their screenshots in a folder per article, inside this project.');
  const value=await ui.ask('Folder for finished articles',current,{
    validate:value=>validExportDir(value) ? undefined : 'Enter a folder inside this project, such as docs/help, without leading / or ..',
  });
  return validExportDir(value) ?? current;
}
async function configureLocalPreferences(ui, current={}) {
  const preferences={...defaultPreferences,...current};
  return {
    prefer_background:await ui.confirm('Write articles in the background when available?',preferences.prefer_background),
    open_when_ready:await ui.confirm('Open the finished article preview in your browser?',preferences.open_when_ready),
  };
}

/** Terminal help-centre selection, opening billing when a plan upgrade is needed. */
export async function chooseHelpCentre(session, bridge, {ui,open=openBrowser}, {bound,replaceProjectId,draft={}}={}) {
  let settings=parse(settingsSchema,await bridge.api.request('GET','/mcp/settings'));
  const {projects}=parse(projectsSchema,await bridge.listProjects());
  const selected=bound ? projects.find(project=>project.id===bound) : undefined;
  if(bound && !selected) fail('permission_denied','The signed-in account cannot access this repository’s help centre.');
  draft.name ??= clean(path.basename(session.options.workspace)).replace(/[-_]+/g,' ');
  ui.line('Choose where this project’s help articles will be saved.');
  while(true) {
    const choices=projects.map(project=>({value:project.id,label:`Use ${clean(project.name)}`,
      hint:project.help_centre_url ? `Existing help centre · ${clean(project.help_centre_url)}` : 'Existing help centre'}));
    if(!bound && (settings.can_create_project || settings.project_creation_upgrade_url)) choices.push({value:'new',label:'Create a new help centre',
      hint:settings.can_create_project ? 'Set up a home for this product’s help articles' : 'Upgrade your plan to add another help centre'});
    if(!selected && !choices.length) fail('permission_denied','No accessible help centres are available and this connection cannot create one.');
    const choice=selected?.id ?? draft.choice ?? (projects.length===0 && settings.can_create_project ? 'new' : await ui.choose('Choose a help centre',choices));
    draft.choice=choice;
    let project;
    if(choice==='new') {
      if(!settings.can_create_project) {
        const url=settings.project_creation_upgrade_url;
        if(!url) fail('permission_denied','This connection cannot create help centres. Run supportpages login, then try again.');
        ui.line('Upgrade your plan to create another help centre.');
        if(!await open(url)) ui.line(`Open this link to upgrade: ${url}`);
        ui.line('After upgrading, return here to continue setup.');
        if(!await ui.confirm('Check your plan and continue?',true)) {
          if(!projects.length) throw new Cancelled();
          delete draft.choice;
          continue;
        }
        settings=parse(settingsSchema,await bridge.api.request('GET','/mcp/settings'));
        if(!settings.can_create_project) {
          ui.line('Your account still cannot create another help centre.');
          delete draft.choice;
          continue;
        }
      }
      ui.line('Use your product or company name. This is the name shown in your help centre.');
      const name=await ui.ask('Help centre name',draft.name, {
        validate:value=>!value || value.length>100 || /[\p{Cc}\p{Cf}]/u.test(value) ? 'Enter a name between 1 and 100 characters.' : undefined,
      });
      draft.name=name;
      ui.line('Choose the name in your help centre’s web address.\nFor example: acme → acme.supportpages.io\nEnter just the name, not a full URL.');
      draft.subdomain=await ui.ask('Help centre address name',draft.subdomain ?? name.toLowerCase().replace(/[^a-z0-9]+/g,'-').slice(0,63).replace(/^-|-$/g,''), {
        validate:value=>/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(value) ? undefined : 'Use 3–63 lowercase letters, numbers or hyphens. Start and end with a letter or number.',
      });
      if(!name || name.length>100 || /[\p{Cc}\p{Cf}]/u.test(name) || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(draft.subdomain)) {
        ui.line('Enter a help centre name and an address name of 3–63 lowercase letters, numbers or hyphens.');
        continue;
      }
      const summary=[`Help centre: ${clean(name)}`,`Address name: ${draft.subdomain}`].join('\n');
      if(ui.note) ui.note(summary,'Ready to create'); else ui.line(summary);
      if(!await ui.confirm('Create this help centre?',true)) throw new Cancelled();
      ui.info?.('Creating your help centre…');
      try { project=parse(createdSchema,await bridge.createProject(name,draft.subdomain)).project; }
      catch(error) {
        if(!['invalid_artifact','permission_denied','plan_limit'].includes(error.code)) throw error;
        if(error.code==='plan_limit') {
          settings=parse(settingsSchema,await bridge.api.request('GET','/mcp/settings'));
          if(!settings.can_create_project && settings.project_creation_upgrade_url) continue;
        }
        ui.line(publicError(error).message);
        if(await ui.confirm('Review your choices and try again?',true)) { delete draft.choice; continue; }
        throw error;
      }
    } else {
      project=projects.find(project=>project.id===choice);
      if(!project) fail('permission_denied','This help centre is no longer accessible. Run supportpages init again.');
      const summary=[`Help centre: ${clean(project.name)}`, ...(project.help_centre_url ? [`Address: ${clean(project.help_centre_url)}`] : []),
        'Your coding agent can read context and upload article drafts.','Review and publish in SupportPages.io.'].join('\n');
      if(ui.note) ui.note(summary,'Ready to connect'); else ui.line(summary);
      if(!await ui.confirm('Connect this help centre?',true)) throw new Cancelled();
    }
    const writingStyleLabel=await chooseWritingStyle(bridge,project.id,settings,ui,draft);
    ui.info?.('Connecting your help centre…');
    if(replaceProjectId && replaceProjectId!==project.id) {
      const saved=await session.switchProject(await session.workspace(),replaceProjectId,project.id);
      if(saved?.archive) ui.line(`Previous project records saved in ${saved.archive}`);
    } else await bridge.bind(project.id);
    return {status:'ready',workspace:session.options.workspace,project_id:project.id,name:project.name,help_centre_url:project.help_centre_url,writing_style:writingStyleLabel};
  }
}

export function retryCommand(options) {
  const quote=value=>"'"+String(value).replaceAll("'", "'\\''")+"'";
  const args=['supportpages','init'];
  if(options.dev) args.push('--dev');
  for(const key of ['project','workspace','api-url','config-dir','skills-dir','app-type']) {
    if(options[key]!==undefined) args.push('--'+key,quote(options[key]));
  }
  if(options.refresh) args.push('--refresh');
  return args.join(' ');
}

const clientLabel = client => client==='codex' ? 'Codex' : 'Claude Code';
/** Signed-in account, when the session can report one. */
const account = async session => session.account ? await session.account().catch(()=>undefined) : undefined;
const clientList = clients => clients.map(clientLabel).join(' and ');

async function registeredClients(config, clients, run) {
  return Promise.all(clients.map(async client=>(await run(client,['mcp','get',config.dev?'supportpages-dev':'supportpages'],{capture:true})).code===0));
}

async function verifyInstallation(config, integration, run) {
  const checks=await generationChecks(integration.skillsDir,run);
  const registered=await registeredClients(config, integration.clients, run);
  if(checks.some(check=>!check.available) || !registered.length || registered.some(value=>!value)) fail('installation_incomplete','The coding-agent integration is incomplete. Run supportpages setup, fix the reported prerequisites, then rerun supportpages init.');
}

/** Coding-agent commands present on this computer, whether or not SupportPages.io is connected to them. */
async function installedAgentCommands(run) {
  const found=[];
  for(const agent of ['codex','claude']) if((await run(agent,['--version'],{capture:true})).code===0) found.push(agent);
  return found;
}

/** Clients recorded by a completed computer setup, or an empty list when this computer has none. */
async function installedClients(config, installRoot, run) {
  if(!await installation(config,installRoot)) return [];
  const receipt=path.join(config.configDir,'installations',`${config.dev ? 'supportpages-dev' : 'supportpages'}.json`);
  let clients=[];
  if(await exists(receipt)) { try { clients=JSON.parse(await readFile(receipt,'utf8')).clients ?? []; } catch { /* Repaired by setup. */ } }
  const usable=[];
  for(const client of clients) {
    if(!['codex','claude'].includes(client)) continue;
    if((await run(client,['--version'],{capture:true})).code!==0) continue;
    if((await run(client,['mcp','get',config.dev?'supportpages-dev':'supportpages'],{capture:true})).code===0) usable.push(client);
  }
  return usable;
}

/**
 * Computer-level setup: the coding-agent integration, the article renderer and the
 * account choice. Nothing here is project-specific; init reuses what it installs.
 */
async function computerSetup(config, options, deps, skillsDir, session) {
  const {ui,run}=deps;
  ui.step?.(1,'Set up your coding agent',3);
  const integration=await ensureIntegration(config,options,deps,skillsDir,session);
  const checks=await generationChecks(integration.skillsDir,run);
  if(checks.some(check=>!check.available)) fail('missing_dependency','Article rendering is not ready. Run supportpages doctor, fix the reported prerequisites, then rerun supportpages setup.');
  ui.step?.(2,'Choose your SupportPages.io account',3);
  let mode;
  // Ask before contacting the service, so choosing local articles works offline.
  if(!await account(session)) {
    ui.line(destinationNote);
    mode=await ui.choose('How would you like to get started?',getStartedChoices);
    if(mode==='local') {
      await saveDevicePreferences(config.configDir,{default_destination:'local'});
      ui.ok('No account needed: articles will be saved in your projects.');
      return {integration,mode,already_signed_in:false,account:undefined};
    }
  }
  const result=await ensureLogin(session,deps,{mode});
  if(result.already_signed_in) ui.ok(`Already signed in as ${clean(result.account?.email ?? 'your account')}.`);
  // Account-wide documentation preferences live with the account, not the folder.
  try { await configurePreferences(await session.bridge(), ui); ui.ok('Documentation preferences saved for your account.'); }
  catch(error) { ui.line(`Documentation preferences could not be read: ${publicError(error).message}`); }
  return {integration,mode:mode ?? 'signin',already_signed_in:Boolean(result.already_signed_in),account:result.account ?? await account(session)};
}

/** The last stage of project setup, shared by hosted and local folders: model defaults, then detection. */
async function detect(session, config, integration, ui, options, deps, { modelStep = 2, analysisStep = 3 } = {}) {
  if(integration.clients.includes('claude')) await selectClaudeConnection({ workspace: session.options.workspace,
    dev: config.dev, configDir: config.configDir, home: deps.home, env: deps.env });
  ui.step?.(modelStep,'Model for this project');
  await confirmAgentModels(session, deps, { clients: integration.clients, agent: options.agent });
  ui.step?.(analysisStep,'Read this project',4);
  const planning = await new Planning(session, options, deps, integration.clients).initialize();
  const analysed = await planning.reviewAnalysis();
  const status = await session.status();
  // A deferred analysis has already closed the wizard with how to run it later.
  if (!analysed) return status;
  ui.step?.(4,'Ready');
  const summary=[
    `Articles  ${destinationLine(status,config)}`,
    `Agent     ${clientList(integration.clients)}`,
    ...writingLines(status,integration.clients),
    ...(status.status==='local' ? [`Hosting   ${authCommand('publish',config)} to put them on a help centre`] : []),
  ].join('\n');
  if(ui.note) ui.note(summary,'This project is ready'); else ui.line(summary);
  await planning.menu();
  return status;
}

/**
 * Where articles are written and what it costs: on this computer it uses the coding
 * agent's own usage; on SupportPages.io (repository connected) the article allowance.
 */
export function writingLines(status, clients) {
  const agents=clients.map(clientLabel).join(' or ');
  if(status.status!=='local' && status.writer_action && status.writer_action.execution!=='local')
    return ['Writing   On SupportPages.io, using your article allowance'];
  const lines=[`Writing   On this computer, using your own ${agents} usage`];
  const connect=status.status==='local' ? undefined : status.repository_connection;
  if(connect?.state==='not_connected') lines.push('          Connect a repository to write on SupportPages.io instead,',`          using your article allowance: ${clean(connect.connect_url)}`);
  return lines;
}

/** What the project's articles are and where they live, for the closing summary. */
function destinationLine(status, config) {
  if(status.status==='local') return `${status.export_dir} · Markdown and screenshots`;
  const url=status.project?.help_centre_url;
  return `${clean(status.project?.name ?? 'SupportPages.io')}${url ? ` · ${clean(url)}` : ''}`;
}

/**
 * The project's coding agent and model. An agent installed on this computer but
 * not connected yet is offered here and connected on choice, so changing agents
 * needs no separate command.
 */
async function configureProjectAgent(config, options, deps, installRoot, run, session, ui, skillsDir) {
  const connected=await installedClients(config,installRoot,run);
  const unconnected=(await installedAgentCommands(run)).filter(agent=>!connected.includes(agent));
  if(!unconnected.length) return await configureAgent(session, deps);
  const choice=await ui.choose('Which coding agent should SupportPages Writer use for this project?',[
    ...connected.map(agent=>({value:agent,label:clientLabel(agent)})),
    ...unconnected.map(agent=>({value:agent,label:`${clientLabel(agent)} — not connected yet`,hint:'SupportPages Writer connects it now'})),
  ],0);
  if(!connected.includes(choice)) {
    const integration=await ensureIntegration(config,options,deps,skillsDir,session,{clients:[...connected,choice]});
    session.options.skillsDir=integration.skillsDir;
  }
  return await configureAgent(session, deps, { clients: [choice], agent: choice });
}

/** Finish a folder that saves articles locally: its settings are already saved. */
async function readyLocally(session, config, integration, ui, run, options, deps, settings) {
  await verifyInstallation(config, integration, run);
  ui.ok(`Articles will be saved in ${clean(settings.export_dir)} as Markdown and screenshots.`);
  return detect(session, config, integration, ui, options, deps);
}

function authCommand(command, config) {
  const quote=value=>"'"+String(value).replaceAll("'", "'\\''")+"'";
  return `supportpages ${command}${config.dev ? ' --dev' : ''}${config.origin!==defaultOrigin(config.dev) ? ' --api-url '+quote(config.origin) : ''}`;
}

// A folder with no destination yet needs setup, not an account: lead with the
// choice that costs nothing and offer hosting on its merits.
const statusHint = (status, config) => status==='setup_required' ? ['Run supportpages init to set up this folder. Articles can be saved right here as Markdown and screenshots, with no account.', ...setupInvitation()]
  : status==='authentication_required' ? [`This folder is linked to a help centre, so it needs a signed-in device. Run ${authCommand('login',config)} to sign in again.`]
  : status==='project_required' ? ['Run supportpages init to choose where this folder’s articles go: a help centre for a public URL and editor review, or saved in the project with no help centre.']
  : status==='local' ? [`Open your coding agent in this folder and ask for an article, or run ${authCommand('publish',config)} to host the saved articles on a help centre.`]
  : ['Run supportpages init to finish setting up this repository.'];

const connectionLabel = status => status==='ready' ? 'connected to a help centre'
  : status==='local' ? 'saving articles in this project (no account needed)'
  : status==='setup_required' ? 'not set up yet — run supportpages init (no account needed)'
  : status==='authentication_required' ? 'linked to a help centre, but this device is signed out'
  : status==='project_required' ? 'signed in; this folder has not chosen where its articles go'
  : status.replaceAll('_',' ');

const cliNotice = notice => notice.replace('Ask me to turn this off', 'Run supportpages telemetry off to stop it');
/** supportpages telemetry on|off|status: device-wide, so it needs no project folder. */
export async function telemetryCommand(action, options, env=process.env) {
  const dev=options.dev ?? developmentMode(env.SUPPORTPAGES_DEV);
  const telemetry=configureTelemetry({configDir:expand(options['config-dir'] ?? defaultConfigDir()),origin:apiOrigin(options['api-url'] ?? env.SUPPORTPAGES_API_URL ?? defaultOrigin(dev),dev),env});
  const result=action==='status' ? await telemetry.status() : await telemetry.setEnabled(action==='on');
  return result;
}
export async function runCli(options, supplied) {
  if(options.project!==undefined && (options.command!=='init' || !remoteId.safeParse(options.project).success)) fail('invalid_request','Use --project with a numeric help-centre ID and the init command.');
  const env={...process.env,...supplied.env};
  // The bundled runtime must also be available to skills/client subprocesses.
  env.PATH=path.dirname(process.execPath)+path.delimiter+(env.PATH ?? '');
  const deps={run:(cmd,args,settings)=>command(cmd,args,{...settings,env}),open:openBrowser,...supplied,env};
  if(env.SUPPORTPAGES_CLI_HOME) {
    try {if(await realpath(path.join(env.SUPPORTPAGES_CLI_HOME,'mcp'))===await realpath(deps.installRoot)) deps.node=path.join(env.SUPPORTPAGES_CLI_HOME,'runtime/bin/node');} catch { /* Ignore stale launcher environment. */ }
  }
  const {ui,installRoot,run}=deps;
  if (options.command === 'remove') return removeIntegration(options, deps);
  const root=await repository(options,deps);
  if (options.command === 'uninit') {
    if (options.dev !== undefined || options['api-url']) fail('invalid_request', 'uninit forgets this folder’s setup in every environment. Omit --dev and --api-url.');
    return uninitWorkspace(root, expand(options['config-dir'] ?? defaultConfigDir()), { ui, yes: options.yes });
  }
  const config=await environment(root,options,env);
  const telemetry=configureTelemetry({configDir:config.configDir,origin:config.origin,installRoot,env,fetcher:deps.fetcher});
  telemetry.start();
  const notice=await telemetry.notice();
  if(notice) ui.info ? ui.info(cliNotice(notice)) : ui.line(cliNotice(notice));
  const installed=await installation(config,installRoot);
  let skillsDir=await installationSkills(installRoot, expand(options['skills-dir'] ?? installed?.skills ?? env.RTFM_SKILLS_DIR ?? path.join(installRoot,'engine')));
  const session=(deps.sessionFactory ?? (value=>new Session(value)))({workspace:root,cwd:root,...config,skillsDir});
  try {
    if(options.command==='logout') {
      ui.info?.(`Signing out of ${config.origin} on this device…`);
      let result;
      try { result=await session.logout(); }
      catch(error) {
        ui.line(`Logout could not finish. Retry ${authCommand('logout',config)}. If the server is unavailable or needs an update, revoke the token in Settings → Local publishing tokens.`);
        throw error;
      }
      ui.ok(result.already_logged_out ? 'This device is already signed out.' : 'Signed out. The device token was revoked and its local credential removed.');
      ui.line(`Your browser account, folder links, project settings and article files are kept. Run ${authCommand('login',config)} to sign in again.`);
      return result;
    }
    if(options.command==='login') {
      ui.intro?.(`SupportPages Writer · Sign in${config.dev?' · Development':''}`);
      if(config.dev || config.origin!==defaultOrigin(config.dev)) ui.line(`Environment: ${config.origin}`);
      const result=await ensureLogin(session,deps,{scopes:options.scopes?.split(',')});
      if(result.already_signed_in) {
        ui.ok(`Already signed in as ${clean(result.account?.email ?? 'your account')}.`);
        ui.line(`To switch accounts, run ${authCommand('logout',config)}, then ${authCommand('login',config)}.`);
      } else ui.line(`Run ${authCommand('init',config)} inside a project folder to connect it to a help centre.`);
      return result;
    }
    if(options.command==='setup') {
      ui.intro?.(`SupportPages Writer · Set up this computer${config.dev?' · Development':''}`,{banner:true});
      const {integration,mode,already_signed_in,account:signedIn}=await computerSetup(config,options,deps,skillsDir,session);
      ui.step?.(3,'Ready',3);
      // The outro below says what to do next; the note only records what was set up.
      const summary=[
        `Coding agent: ${clientList(integration.clients)}`,
        `Account: ${mode==='local' ? 'none — articles are saved in your projects' : clean(signedIn?.email ?? 'signed in')}`,
      ].join('\n');
      if(ui.note) ui.note(summary,'This computer is set up'); else ui.line(summary);
      ui.outro?.(mode==='local'
        ? `Run ${authCommand('init',config)} in a project to set up writing.\nOptional: ${authCommand('publish',config)} hosts saved articles on a help centre later.`
        : `Run ${authCommand('init',config)} in a project to choose a help centre and write articles.`);
      return {status:mode==='local'?'local':'signed_in',api_origin:config.origin,already_signed_in,...(signedIn?{account:signedIn}:{})};
    }
    if(options.command==='sync') {
      const result=await (await session.bridge()).sync();
      if(options.json) ui.line(JSON.stringify(result),{literal:true});
      else {
        ui.line(`Help centre: ${clean(result.project.name)}`);
        if(result.project.help_centre_url) ui.line(clean(result.project.help_centre_url));
        if(result.status==='ready') {
          ui.ok(`Synced ${result.counts.remote} remote articles.`);
          for(const item of result.articles) {
            const title=item.remote?.title ?? item.title ?? 'Untitled article';
            ui.line(`${clean(title)} · ${item.sync_status.replaceAll('_',' ')}${item.remote?.status ? ` · ${item.remote.status}` : ''}${item.identity_mismatch ? ' · server remembers a different local copy; this folder’s record is used' : ''}`);
            if(item.remote?.editor_url) ui.line(clean(item.remote.editor_url));
          }
          if(result.walkthroughs?.status==='ready') {
            ui.ok(`Synced ${result.walkthroughs.counts.remote} remote video walkthroughs.`);
            for(const item of result.walkthroughs.items) {
              const video=item.remote;
              ui.line(`${clean(video?.title ?? item.last_known?.title ?? 'Unavailable video')} · ${item.sync_status.replaceAll('_',' ')}${video ? ` · ${video.generation_status} · ${video.public_on_article ? 'on public article' : 'not on public article'} · ${video.public_url ? 'share link live' : 'no live share link'}` : ''}`);
              if(video?.review_url) ui.line(clean(video.review_url));
            }
          }
        }
        ui.line(result.instructions);
      }
      return result;
    }
    if(options.command==='status') {
      const status=await session.status();
      if(options.json) ui.line(JSON.stringify(status),{literal:true});
      else {
        ui.line(`${clean(root)} — ${status.status==='ready'?'Connected':status.status==='local'?'Local articles':status.status==='setup_required'?'Not set up yet':status.status==='project_required'?'Destination not chosen':clean(status.status.replaceAll('_',' '))}`);
        ui.line(`Environment: ${config.origin}`);
        if(status.account?.email) ui.line(`Signed in as ${clean(status.account.email)}`);
        if(status.project) ui.line(`Help centre: ${clean(status.project.name)}`);
        if(status.status==='local') ui.line(`Articles are saved in ${clean(status.export_dir)} as Markdown and screenshots. No account is connected.`);
        ui.line(`Analysis: ${status.analysis?.status ?? 'required'}${status.generation_ready ? ' · ready to write' : ''}`);
        if(status.setup_task) ui.line(`Last setup progress: ${clean(status.setup_task.skill)} · ${clean(status.setup_task.status)}`);
        if(status.setup_task?.total !== undefined) ui.line(`Articles: ${status.setup_task.completed ?? 0}/${status.setup_task.total} drafts ready · ${status.setup_task.failed ?? 0} failed`);
        if(status.article_run) ui.line(JSON.stringify(status.article_run,null,2),{literal:true});
        if(status.status!=='ready') for(const line of statusHint(status.status,config)) ui.line(line);
      }
      return status;
    }
    if(options.command==='doctor') {
      const checks=await generationChecks(skillsDir,run);
      const clientChecks=[];
      for(const client of ['codex','claude']) {
        const available=(await run(client,['--version'],{capture:true})).code===0;
        const registered=available && (await run(client,['mcp','get',config.dev ? 'supportpages-dev':'supportpages'],{capture:true})).code===0;
        clientChecks.push({client,available,registered});
      }
      const plugin=await claudePluginInstalled({home:deps.home ?? os.homedir(),env:deps.env});
      const result={workspace:root,api_origin:config.origin,checks,coding_clients:clientChecks,claude_plugin:plugin,connection:await session.status(),telemetry:await telemetry.status()};
      if(options.json) ui.line(JSON.stringify(result),{literal:true});
      else {
        ui.line(`Repository: ${clean(root)}\nEnvironment: ${config.origin}`);
        for(const check of checks) ui.line(`${check.available?'OK':'Missing'}: ${check.name}`);
        for(const client of clientChecks) ui.line(`${client.client}: ${client.registered?'MCP registered':client.available?'MCP not registered':'not installed'}`);
        ui.line(`Connection: ${clean(connectionLabel(result.connection.status))}`);
        ui.line(`Anonymous usage reporting: ${result.telemetry.enabled?'on':'off'} (${result.telemetry.reason})${result.telemetry.enabled?' · supportpages telemetry off to stop it':''}`);
        for(const client of clientChecks) if(client.available && !client.registered && !(client.client==='claude' && plugin)) ui.line(`${clientLabel(client.client)} is installed but not connected. Run supportpages setup to connect it.`);
        if(plugin) ui.line(clientChecks.find(client=>client.client==='claude')?.registered ? 'Claude Code has the SupportPages Writer plugin and a separate registration, so its tools appear twice. Run supportpages remove --agent claude to keep only the plugin.' : 'Claude Code: SupportPages Writer plugin installed.');
        if(checks.some(check=>!check.available) || !clientChecks.some(client=>client.registered)) ui.line('Run supportpages setup to finish the integration; it downloads Chromium for screenshots if it is missing. Git and your coding agent must be available in your terminal.');
      }
      return result;
    }
    if(options.command==='publish') {
      ui.intro?.(`SupportPages Writer · Publish${config.dev?' · Development':''}`);
      const initial=await session.bridge();
      const destination=await initial.destination();
      if(destination==='none') fail('project_required','Run supportpages init to set up this folder first.');
      const articles=await initial.localArticles();
      if(!articles.length) {
        if(destination==='hosted') { ui.ok('Every saved article in this folder is already on SupportPages.io.'); return session.status(); }
        fail('nothing_to_publish','No saved articles to publish yet. Ask your coding agent to write one first.');
      }
      await ensureWriterAvailable(initial, ui);
      const local=await initial.local();
      ui.line(`${articles.length} saved article${articles.length===1?'':'s'} in this folder:`);
      for(const item of articles) ui.line(`  ${clean(item.title)}`);
      const total=destination==='local' ? 3 : 1;
      if(destination==='local') {
        ui.info?.('Publishing needs a SupportPages.io account. Your articles stay in this folder as well.');
        ui.step?.(1,'Sign in to SupportPages.io',total);
        const mode=await account(session) ? undefined : await ui.choose('How would you like to sign in?',getStartedChoices.slice(0,2));
        await ensureLogin(session,deps,{mode});
        const signedIn=await session.bridge();
        const status=await session.status();
        if(status.status==='connection_error') fail('connection_error', status.error?.message ?? 'SupportPages.io could not be reached. Check your connection and retry supportpages publish.');
        ui.step?.(2,'Choose your help centre',total);
        await chooseHelpCentre(session,signedIn,deps,{draft:{writingStyle:local?.writing_style}});
        await privateJson(profileFile(config.configDir,root),{version:1,workspace:root,origin:config.origin,dev:config.dev});
      } else await ensureLogin(session,deps);
      ui.step?.(total,'Upload your articles',total);
      const bridge=await session.bridge();
      const verified=await session.status();
      if(verified.status!=='ready') fail('connection_error','The help centre connection could not be verified. Run supportpages status, then retry supportpages publish.');
      await bridge.sync();
      const chosen=await ui.multiselect('Which articles should be uploaded as drafts?',articles.map(item=>({value:item.slug,label:clean(item.title)})),articles.map(item=>item.slug));
      const result=await bridge.uploadLocalArticles(chosen,event=>{
        if(event.error) {
          ui.line(`${clean(event.title)}: ${event.error.message}`);
          if(event.error.code==='plan_limit') ui.line('The remaining articles were not uploaded. Free up capacity or upgrade, then run supportpages publish again.');
        } else if(event.editor_url) ui.ok(`${clean(event.title)} · ${clean(event.editor_url)}`);
        else ui.info?.(`Uploading ${clean(event.title)}…`);
      });
      const uploaded=result.uploaded ?? [];
      ui.outro?.(uploaded.length
        ? `${uploaded.length} draft${uploaded.length===1?'':'s'} uploaded to ${clean(verified.project.name)}. Review and publish them in SupportPages.io. This folder now publishes to that help centre; ask your coding agent for the next article.`
        : `This folder now publishes to ${clean(verified.project.name)}. No drafts were uploaded.`);
      return {status:'published',project_id:verified.project_id,help_centre_url:verified.project.help_centre_url,uploaded};
    }
    if(['sections','recommend'].includes(options.command)) {
      const bridge = await session.bridge();
      const decision = await resolveAction(bridge, options.command === 'sections' ? 'suggest_sections' : 'recommend_articles');
      requireExecution(decision, 'hosted');
      const result=await bridge.hosted.submit(options.command==='sections'?'suggest_sections':'recommend_articles',{}, {decision});
      ui.line(`Operation ${result.operation_id}: ${result.status}`);
      if(result.review_url)ui.line(result.review_url);
      return result;
    }
    if(['analyse','write'].includes(options.command)) {
      const status = await session.status();
      if(!['ready','local'].includes(status.status)) fail(status.status==='setup_required'?'setup_required':'authentication_required','Run supportpages init to set up this project first.');
      ui.intro?.(`SupportPages Writer · ${options.command}${config.dev?' · Development':''}`);
      if(options.command === 'write') {
        const bridge=await session.bridge();
        const decision=await resolveAction(bridge,'create_article');
        if(!decision.allowed) requireExecution(decision,decision.execution);
        if(decision.execution==='hosted') {
          const title=await ui.ask('Which article should SupportPages write?',undefined,{validate:value=>value?.trim() ? undefined : 'Enter an article title.'});
          const result=await bridge.createArticle({title,article_type:'how-to'});
          ui.line(`Operation ${result.operation_id}: ${result.status}`);
          if(result.review_url)ui.line(result.review_url);
          return result;
        }
      }
      const planning = await new Planning(session,options,deps).initialize();
      if(options.command === 'analyse') { await planning.reviewAnalysis(); return session.status(); }
      if(options.command === 'write') return planning.write();
      return;
    }
    if (options.command === 'configure') {
      ui.intro?.(`SupportPages Writer · This project${config.dev?' · Development':''}`);
      const bridge = await session.bridge();
      const destination = await bridge.destination();
      if (destination === 'none') fail('project_required', 'Run supportpages init to set up this project before configuring it.');
      const local = destination === 'local' ? await bridge.local() : undefined;
      // Project settings only: the computer's agents live in setup, and a help
      // centre's writing style and the account's preferences are asked for by init
      // and setup respectively.
      if (!local) return await configureProjectAgent(config, options, deps, installRoot, run, session, ui, skillsDir);
      const area = await ui.choose('What would you like to configure?', [
        { value: 'agent', label: 'Coding agent and model' },
        { value: 'writing_style', label: 'Writing style' },
        { value: 'preferences', label: 'Documentation preferences' },
        { value: 'export_dir', label: 'Article folder' },
        { value: 'hosting_reminders', label: 'Hosting reminders', hint: 'Occasional notes after a saved article about hosting it on SupportPages.io' },
      ]);
      if (area === 'agent') return await configureProjectAgent(config, options, deps, installRoot, run, session, ui, skillsDir);
      if (area === 'hosting_reminders') {
        // A device preference for every local folder, not a folder setting.
        const current = await bridge.hostingReminders();
        const enabled = await ui.confirm('Show occasional reminders about hosting saved articles on SupportPages.io?', current.enabled);
        await bridge.hostingReminders(enabled);
        ui.ok(enabled ? 'Hosting reminders are on for local folders on this computer.' : 'Hosting reminders are off for local folders on this computer until you enable them again.');
        return session.status();
      }
      // No account is involved: these settings live in the folder.
      const settings = area === 'writing_style' ? { ...local, writing_style: await chooseLocalWritingStyle(ui, local.writing_style) }
        : area === 'preferences' ? { ...local, preferences: await configureLocalPreferences(ui, local.preferences) }
        : { ...local, export_dir: await askExportDir(ui, local.export_dir) };
      await bridge.saveLocal(settings);
      ui.ok(area === 'writing_style' ? 'Writing style saved for this folder.' : area === 'preferences' ? 'Your preferences have been saved for this folder.' : `Finished articles will be saved in ${clean(settings.export_dir)}.`);
      await privateJson(profileFile(config.configDir,root),{version:1,workspace:root,origin:config.origin,dev:config.dev});
      return session.status();
    }
    const title=`SupportPages Writer · Set up this project${config.dev?' · Development':''}`;
    if(ui.intro) ui.intro(title,{banner:true});
    else ui.line(title);
    const initial=await session.bridge();
    const savedBinding=await initial.ws.exists(`${initial.stateRoot}/binding.json`) ? (await initial.binding()).project_id : undefined;
    const savedLocal=savedBinding ? undefined : await initial.local();
    const details=`${clean(path.basename(root))}${root===path.basename(root) ? '' : `  (${clean(root)})`}`;
    ui.line(details);

    // The coding-agent integration is computer-level: install it once with setup,
    // and only offer that here rather than repeating it for every project.
    let clients=await installedClients(config,installRoot,run);
    let integration;
    if(!clients.length) {
      ui.line('This computer is not set up for SupportPages Writer yet.');
      if(!await ui.confirm('Set it up now?',true)) throw new Cancelled('Setup cancelled. Run supportpages setup when you are ready, then rerun supportpages init.');
      const installed=await computerSetup(config,options,deps,skillsDir,session);
      integration=installed.integration; skillsDir=integration.skillsDir;
    } else {
      integration=await ensureIntegration(config,options,deps,skillsDir,session,{clients});
      skillsDir=integration.skillsDir;
    }
    session.options.skillsDir=skillsDir;
    const checks=await generationChecks(skillsDir,run);
    if(checks.some(check=>!check.available)) fail('missing_dependency','Article rendering is not ready. Run supportpages doctor, fix the reported prerequisites, then rerun supportpages init.');

    ui.step?.(1,'Where articles go',4);
    let hosted=Boolean(savedBinding || options.project);
    let replaceProjectId, bound=options.project ?? savedBinding, result;
    if(savedLocal) {
      const message=`This project saves articles in ${clean(savedLocal.export_dir)} as Markdown and screenshots. No SupportPages.io account is connected.`;
      if(ui.note) ui.note(message,'Local articles'); else ui.line(message);
      hosted=!await ui.confirm('Keep saving articles in this project?',true);
      if(!hosted) {
        // Keeping the setup asks nothing: supportpages configure changes its settings.
        result=await readyLocally(session,config,integration,ui,run,options,deps,savedLocal);
        await privateJson(profileFile(config.configDir,root),{version:1,workspace:root,origin:config.origin,dev:config.dev});
        return result;
      }
    } else if(!hosted) {
      const preferLocal=(await devicePreferences(config.configDir)).default_destination==='local' && !await account(session);
      ui.line(destinationNote);
      const choice=await ui.choose('Where should finished articles go?',[
        {value:'hosted',label:'Publish them to a SupportPages.io help centre'},
        {value:'local',label:'Save them in this project without an account'},
      ],preferLocal ? 1 : 0);
      hosted=choice==='hosted';
      if(!hosted) {
        const settings={ version:1, export_dir:'output/articles', writing_style: await chooseLocalWritingStyle(ui, defaultWritingStyle) };
        settings.export_dir=await askExportDir(ui, settings.export_dir);
        await initial.saveLocal(settings);
        result=await readyLocally(session,config,integration,ui,run,options,deps,settings);
        await privateJson(profileFile(config.configDir,root),{version:1,workspace:root,origin:config.origin,dev:config.dev});
        return result;
      }
    }

    // Hosted: sign in, then reuse or choose the help centre.
    if(!await account(session)) await ensureLogin(session,deps);
    const bridge=await session.bridge();
    const status=await session.status();
    if(status.status==='connection_error') fail('connection_error', status.error?.message ?? 'SupportPages.io could not be reached. Check your connection and retry supportpages init.');
    if(savedBinding && status.status!=='ready') {
      const unavailable=status.status==='project_unavailable';
      const message=unavailable
        ? `The previously linked help centre (Project ${savedBinding}) is no longer available to this account. It may have been deleted or your access may have changed.`
        : `The previous link to Project ${savedBinding} could not be verified. Choose a help centre for this repository.`;
      if(ui.note) ui.note(message,unavailable?'Previous help centre unavailable':'Reconnect SupportPages.io');
      else ui.line(message);
      if(unavailable && options.project===savedBinding) fail('project_unavailable','The requested project is no longer accessible. Run init without --project to choose or create a help centre.');
      await ensureWriterAvailable(bridge, ui);
      replaceProjectId=savedBinding;
      bound=options.project;
    }
    if(savedBinding && status.status==='ready') {
      const url=status.project?.help_centre_url;
      const message=`This project publishes to ${clean(status.project.name)}${url ? `\n${clean(url)}` : ''}`;
      if(ui.note) ui.note(message,'Existing connection'); else ui.line(message);
      const explicitSwitch=options.project && options.project!==savedBinding;
      const keep=explicitSwitch
        ? !await ui.confirm(`Switch this repository to SupportPages.io project ${options.project}?`,false)
        : await ui.confirm('Keep publishing to this help centre?',true);
      if(explicitSwitch && keep) throw new Cancelled();
      if(keep) {
        if(await ui.confirm('Change the writing style for this help centre?',false)) {
          const settings=parse(settingsSchema,await bridge.api.request('GET','/mcp/settings'));
          await chooseWritingStyle(bridge,savedBinding,settings,ui);
          ui.ok('Writing style saved for this help centre.');
        }
        const synchronization=await bridge.sync();
        if(synchronization.status==='ready') ui.line(`Synced ${synchronization.counts.remote} remote articles.`);
        result=await detect(session,config,integration,ui,options,deps);
        await privateJson(profileFile(config.configDir,root),{version:1,workspace:root,origin:config.origin,dev:config.dev});
        return result;
      }
      await ensureWriterAvailable(bridge, ui);
      replaceProjectId=savedBinding;
      bound=explicitSwitch ? options.project : undefined;
    }
    // Choosing a help centre is a sub-step of "where articles go", so it keeps step 1's number.
    const chosen=await chooseHelpCentre(session,bridge,deps,{bound,replaceProjectId,draft:{writingStyle:savedLocal?.writing_style}});
    await privateJson(profileFile(config.configDir,root),{version:1,workspace:root,origin:config.origin,dev:config.dev});
    result=await detect(session,config,integration,ui,options,deps);
    return result;
  } catch(error) {
    // The caller prints the error first, then this hint: the message must come
    // before the recovery command, not the other way round.
    if(options.command==='init' && !(error instanceof Cancelled) && error && typeof error==='object') error.retryHint=`Retry: ${retryCommand(options)}`;
    throw error;
  } finally {session.close();}
}
