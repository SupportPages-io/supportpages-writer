#!/usr/bin/env node
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile, realpath, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { command, checkSkills, exists } from './lib/install.mjs';

const {values}=parseArgs({options:{local:{type:'boolean'},'runtime-dir':{type:'string'},out:{type:'string'}}});
if(values.local && values['runtime-dir']) throw Error('--local uses this machine’s runtime. Use --runtime-dir for a public release.');
if(!values.local && !values['runtime-dir']) throw Error('Use --local, or --runtime-dir with a built checkout.');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
// The article engine ships in this repository (exported from the skills repository).
const engine=path.join(root,'engine');
await checkSkills(engine);
const version=JSON.parse(await readFile(path.join(root,'package.json'),'utf8')).version;
const lock=JSON.parse(await readFile(path.join(root,'package-lock.json'),'utf8'));
if(lock.version!==version || lock.packages?.['']?.version!==version) throw Error('Keep package.json and package-lock.json release versions aligned.');
if(!/^\d+\.\d+\.\d+$/.test(version)) throw Error('Release versions must be X.Y.Z.');
if(!['darwin','linux'].includes(process.platform) || !['x64','arm64'].includes(process.arch)) throw Error('Unsupported release platform.');
let npmRoot;
if(values.local) {
  const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
  if(nodeMajor < 22 || nodeMajor === 22 && nodeMinor < 12) throw Error('Local builds require Node.js 22.12 or later.');
  // Find npm next to Node first (nvm/official distributions), then on PATH
  // (Homebrew). Copy its package, not the entire system runtime prefix.
  for(const directory of [path.dirname(process.execPath),...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean)]) {
    const candidate=path.join(directory,'npm');
    if(!await exists(candidate)) continue;
    const executable=await realpath(candidate);
    const candidateRoot=path.dirname(path.dirname(executable));
    if(await exists(path.join(candidateRoot,'bin/npm-cli.js'))) {npmRoot=candidateRoot;break;}
  }
  if(!npmRoot) throw Error('Could not find npm alongside Node or on PATH. Install npm and rerun the installer.');
  const npmArgs=[path.join(npmRoot,'bin/npm-cli.js')];
  const env={...process.env,PATH:path.dirname(process.execPath)+path.delimiter+(process.env.PATH ?? '')};
  const checked=async args=>{
    const result=await command(process.execPath,[...npmArgs,...args],{cwd:root,capture:true,env});
    if(result.stdout) process.stderr.write(result.stdout);
    if(result.stderr) process.stderr.write(result.stderr);
    if(result.code) throw Error(`npm ${args[0]} failed. Fix the reported issue and rerun the installer.`);
  };
  const dependencies=await command(process.execPath,[...npmArgs,'ls','--include=dev','--all'],{cwd:root,capture:true,env});
  if(dependencies.code) {
    process.stderr.write('Installing build dependencies...\n');
    await checked(['ci','--include=dev','--no-audit','--no-fund','--prefer-offline']);
  }
  process.stderr.write('Building SupportPages Writer...\n');
  await checked(['run','build']);
} else {
  npmRoot=path.dirname(path.dirname(await realpath(path.join(values['runtime-dir'],'bin/npm'))));
}
const stage=await mkdtemp(path.join(os.tmpdir(),'supportpages-release-'));
const out=path.resolve(values.out ?? path.join(root,'release'));
try {
  const bundle=path.join(stage,'supportpages');await mkdir(path.join(bundle,'mcp'),{recursive:true});
  if(values.local) {
    await mkdir(path.join(bundle,'runtime/bin'),{recursive:true});
    await cp(process.execPath,path.join(bundle,'runtime/bin/node'),{dereference:true});
    // Homebrew's Node executable loads libnode relative to its runtime prefix.
    // Copy that library too, without pulling in unrelated system packages.
    const lib=path.resolve(path.dirname(process.execPath),'../lib');
    if(await exists(lib)) for(const name of await readdir(lib)) {
      if(!/^libnode[.-]/.test(name)) continue;
      await mkdir(path.join(bundle,'runtime/lib'),{recursive:true});
      await cp(path.join(lib,name),path.join(bundle,'runtime/lib',name),{dereference:true});
    }
  } else await cp(values['runtime-dir'],path.join(bundle,'runtime'),{recursive:true,dereference:true});
  await cp(npmRoot,path.join(bundle,'runtime/lib/node_modules/npm'),{recursive:true,dereference:true});
  for(const name of ['npm','npx']) {
    const script=path.join(bundle,'runtime/bin',name);
    await writeFile(script,`#!/bin/sh\nsp_runtime_bin="$(cd -- "$(dirname -- "$0")" && pwd)"\nexec "$sp_runtime_bin/node" "$sp_runtime_bin/../lib/node_modules/npm/bin/${name}-cli.js" "$@"\n`);
    await chmod(script,0o755);
  }
  const npmProbe=await command(path.join(bundle,'runtime/bin/npm'),['--version'],{capture:true});
  if(npmProbe.code) {process.stderr.write(npmProbe.stderr);throw Error('Bundled npm smoke test failed.');}
  for(const name of ['dist','scripts','engine','install.sh','install-cli.sh','package.json','package-lock.json','README.md','LICENSE','NOTICE','node_modules']) await cp(path.join(root,name),path.join(bundle,'mcp',name),{recursive:true,dereference:true});
  await rm(path.join(bundle,'mcp/node_modules/typescript'),{recursive:true,force:true});
  await rm(path.join(bundle,'mcp/node_modules/@types'),{recursive:true,force:true});
  const probe=await command(path.join(bundle,'runtime/bin/node'),[path.join(bundle,'mcp/scripts/cli.mjs'),'--version'],{capture:true});
  if(probe.code || probe.stdout.trim()!==version) {process.stderr.write(probe.stderr);throw Error('Bundled runtime smoke test failed.');}
  await writeFile(path.join(bundle,'release.json'),JSON.stringify({version,platform:process.platform,arch:process.arch,node:process.version,engine:(await readFile(path.join(engine,'VERSION'),'utf8')).trim(),...(values.local ? {local:true} : {})})+'\n');
  await mkdir(out,{recursive:true});
  const archive=path.join(out,`supportpages-${version}-${process.platform}-${process.arch}.tar.gz`);
  // -h stores symlink targets as ordinary files, so extraction needs no link
  // support or trust. The stage was copied with dereference, so it holds no
  // hardlinks either. COPYFILE_DISABLE keeps macOS metadata out of the archive.
  const result=await command('tar',['-czhf',archive,'-C',stage,'supportpages'],{capture:true,env:{...process.env,COPYFILE_DISABLE:'1'}});
  if(result.code) throw Error('Could not create the release archive.');
  const digest=createHash('sha256').update(await readFile(archive)).digest('hex');
  await writeFile(archive+'.sha256',`${digest}  ${path.basename(archive)}\n`);
  process.stdout.write(archive+'\n');
} finally {await rm(stage,{recursive:true,force:true});}
