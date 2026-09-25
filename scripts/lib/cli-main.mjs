import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, realpath } from 'node:fs/promises';
import { createTerminal, Cancelled, emphasizeCommands } from './terminal.mjs';
import { publicError } from '../../dist/errors.js';
import { runCli, telemetryCommand } from './cli.mjs';
import { reportError } from '../../dist/telemetry.js';
import { updateCli } from './update.mjs';

let installRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
if(process.env.SUPPORTPAGES_CLI_HOME) {
  const stableRoot=path.join(process.env.SUPPORTPAGES_CLI_HOME,'mcp');
  try {if(await realpath(stableRoot)===await realpath(installRoot)) installRoot=stableRoot;} catch { /* Ignore stale launcher environment. */ }
}
const help=`SupportPages Writer — local article generation

Usage: supportpages <command> [options]

  setup       One-time setup for this computer: coding agent, renderer and account
  init        Set up this project: where its articles go, model and project detection
  uninit      Forget this folder's setup and environment; archive recovery files
  publish     Host this project's locally saved articles on a SupportPages.io help centre
  analyse     Complete required project analysis (--refresh to rerun)
  status      Show the connection and last-reported article progress
  configure   Choose coding agent, model, effort, writing style and preferences
  login       Sign in to SupportPages.io on this computer (one browser approval)
  logout      Sign out of SupportPages.io on this computer
  sync        Refresh remote project settings and article history
  doctor      Check your installation and generation prerequisites
  telemetry   Show or change anonymous usage reporting: telemetry on|off|status
  update      Install the latest SupportPages Writer release; keep your settings and articles
  remove      Remove local coding-agent integrations; keep projects and articles
  mcp         Run the MCP server on stdio (for MCP client configuration)

Run supportpages setup once on this computer and supportpages init inside each
project, then open Claude Code or Codex there and ask for an article. Articles can be saved in the project as Markdown and screenshots with no
account, or published to a SupportPages.io help centre. Your repository stays
with your coding agent.

Permission consent: supportpages login --scopes manage,generate,publish

Options: --workspace PATH, --dev, --api-url ORIGIN, --config-dir PATH,
         --skills-dir PATH, --project ID (init), --agent claude|codex,
         --refresh (init, analyse), --app-type TYPE (init, analyse),
         --skills-only (remove), --yes (remove/uninit),
         --json (status/doctor/sync), --help, --version
`;
try {
  let parsed;
  try {parsed=parseArgs({allowPositionals:true,options:{
    ...Object.fromEntries(['workspace','api-url','config-dir','skills-dir','project','agent','app-type','scopes'].map(name=>[name,{type:'string'}])),
    'skills-only':{type:'boolean'},yes:{type:'boolean'},refresh:{type:'boolean'},dev:{type:'boolean'},json:{type:'boolean'},help:{type:'boolean',short:'h'},version:{type:'boolean',short:'v'},
  }});} catch {throw Object.assign(new Error(),{usage:true});}
  const {values,positionals}=parsed;
  if(values.version) process.stdout.write(JSON.parse(await readFile(path.join(installRoot,'package.json'),'utf8')).version+'\n');
  else if(values.help || positionals.length===0) process.stdout.write(emphasizeCommands(help));
  else {
    const command=positionals[0];
    if(command==='telemetry') {
      const action=positionals[1] ?? 'status';
      if(positionals.length>2 || !['on','off','status'].includes(action) || Object.keys(values).some(key=>!['dev','api-url','config-dir','json'].includes(key))) throw Object.assign(new Error(),{usage:true});
      const result=await telemetryCommand(action,values);
      if(values.json) process.stdout.write(JSON.stringify(result)+'\n');
      else process.stdout.write(`${result.message ?? `Anonymous usage reporting is ${result.enabled?'on':'off'} (${result.reason}).`}\n${result.sends}\n${result.disable}\n`);
    } else if(command==='update') {
      if(positionals.length!==1 || Object.keys(values).length) throw Object.assign(new Error(),{usage:true});
      await updateCli({installRoot,ui:createTerminal()});
    } else {
      if((values.scopes !== undefined && (command !== 'login' || !/^(publish|manage|generate)(,(publish|manage|generate))*$/.test(values.scopes))) || (command === 'remove' && values.workspace !== undefined) || (values.yes && !['remove','uninit'].includes(command)) || (values['skills-only'] && command!=='remove') || (values.project !== undefined && (command!=='init' || !/^[1-9][0-9]*$/.test(values.project))) || positionals.length!==1 || !['setup','init','uninit','login','logout','status','configure','doctor','analyse','sections','recommend','write','publish','remove','sync'].includes(command) || (values.json && !['status','doctor','sync'].includes(command)) || (values.agent && !['claude','codex'].includes(values.agent)) || (values.refresh && !['init','analyse','sections','recommend'].includes(command)) || (values['app-type'] && (!['init','analyse'].includes(command) || !['web','terminal','mobile','desktop','win32','macos','game'].includes(values['app-type'])))) throw Object.assign(new Error(),{usage:true});
      if(!['status','doctor','sync','logout'].includes(command) && !(['remove','uninit'].includes(command) && values.yes) && (!process.stdin.isTTY || !process.stdout.isTTY)) {process.stderr.write('Run supportpages '+command+' in an interactive terminal. Use status --json or doctor --json for automation.\n');process.exitCode=2;}
      else await runCli({...values,command},{installRoot,ui:createTerminal()});
    }
  }
} catch(error) {
  if(error.usage) {process.stderr.write(emphasizeCommands('Invalid command or options. Run supportpages --help.\n',process.stderr));process.exitCode=2;}
  else {if(!(error instanceof Cancelled)) reportError(error);process.stderr.write(emphasizeCommands((error instanceof Cancelled ? error.message : publicError(error).message)+'\n',process.stderr));process.exitCode=error instanceof Cancelled || error.code==='authorization_cancelled' ? 130:1;}
}
