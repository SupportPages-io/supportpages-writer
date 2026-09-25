import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, mkdtemp, rm, symlink, lstat, copyFile, readlink, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

async function archiveFixture(t,version='0.1.0',unsafe=false,contents='fixture') {
  const root=await mkdtemp(path.join(os.tmpdir(),"supportpages release ' literal-"));t.after(()=>rm(root,{recursive:true,force:true}));
  const staged=path.join(root,'supportpages');await mkdir(path.join(staged,'runtime/bin'),{recursive:true});await mkdir(path.join(staged,'mcp/scripts'),{recursive:true});
  // A tiny runtime fixture lets installer failure tests run without copying Node.
  // The real release smoke test separately exercises the bundled Node executable.
  await writeFile(path.join(staged,'runtime/bin/node'),`#!/bin/sh\nif [ "$1" = '-e' ]; then exec '${process.execPath.replaceAll("'", "'\\''")}' "$@"; else printf '%s\\n' '${version}'; fi\n`,{mode:0o755});
  await writeFile(path.join(staged,'mcp/scripts/cli.mjs'),contents);
  if(unsafe) await symlink('/tmp',path.join(staged,'escape'));
  const file=path.join(root,`supportpages-${version}-${process.platform}-${process.arch}.tar.gz`);
  const tar=spawnSync('tar',['-czf',file,'-C',root,'supportpages'],{encoding:'utf8'});assert.equal(tar.status,0,tar.stderr);
  await writeFile(file+'.sha256',createHash('sha256').update(await readFile(file)).digest('hex')+'  '+path.basename(file)+'\n');
  return {root,file,data:path.join(root,'data'),bin:path.join(root,'bin')};
}
const install=(f,extra=[])=>spawnSync('bash',['install-cli.sh','--yes','--archive',f.file,'--data-dir',f.data,'--bin-dir',f.bin,...extra],{encoding:'utf8',timeout:10000});

async function repack(f) {
  const result=spawnSync('tar',['-czf',f.file,'-C',f.root,'supportpages'],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  await writeFile(f.file+'.sha256',createHash('sha256').update(await readFile(f.file)).digest('hex')+'  '+path.basename(f.file)+'\n');
}

async function sourceFixture(t) {
  const f=await archiveFixture(t);
  const checkout=path.join(f.root,'checkout');
  await mkdir(path.join(checkout,'src'),{recursive:true});
  await mkdir(path.join(checkout,'scripts'));
  await copyFile('install-cli.sh',path.join(checkout,'install-cli.sh'));
  await writeFile(path.join(checkout,'src/index.ts'),'source');
  await writeFile(path.join(checkout,'package-lock.json'),'{}');
  await writeFile(path.join(checkout,'archive-path'),f.file);
  // Exercise the actual shell install flow with a small build fixture. The real
  // source builder is also smoke-tested against the checkout and bundled Node.
  await writeFile(path.join(checkout,'scripts/build-release.mjs'),`
import { mkdir, readFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
const {values}=parseArgs({options:{local:{type:'boolean'},out:{type:'string'}}});
if(!values.local) process.exit(2);
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const archive=await readFile(path.join(root,'archive-path'),'utf8');
await mkdir(values.out,{recursive:true});
const target=path.join(values.out,path.basename(archive));
await copyFile(archive,target);
await copyFile(archive+'.sha256',target+'.sha256');
process.stdout.write(target+'\\n');
`);
  const env={...process.env};delete env.SUPPORTPAGES_CLI_RELEASE_URL;
  const run=(extra=[],overrides={})=>spawnSync('bash',[path.join(checkout,'install-cli.sh'),'--yes','--data-dir',f.data,'--bin-dir',f.bin,...extra],{
    cwd:f.root,encoding:'utf8',timeout:10000,env:{...env,...overrides},
  });
  return {...f,checkout,run};
}

test('a checkout builds and installs without an archive flag, including from another directory',async t=>{
  const f=await sourceFixture(t);
  const first=f.run();assert.equal(first.status,0,first.stderr);
  assert.match(first.stdout,/Source checkout detected/);
  assert.match(await readlink(path.join(f.data,'current')),/0\.1\.0-.+-local-[a-f0-9]{64}$/);
  const run=spawnSync(path.join(f.bin,'supportpages'),['--version'],{encoding:'utf8',env:{PATH:'/usr/bin:/bin'}});
  assert.equal(run.status,0,run.stderr);assert.equal(run.stdout.trim(),'0.1.0');
});

test('changed local source can be reinstalled at the same version and failed builds keep the working install',async t=>{
  const f=await sourceFixture(t);
  assert.equal(f.run().status,0);
  const first=await readlink(path.join(f.data,'current'));
  const updated=await archiveFixture(t,'0.1.0',false,'updated source');
  await writeFile(path.join(f.checkout,'archive-path'),updated.file);
  const reinstall=f.run();assert.equal(reinstall.status,0,reinstall.stderr);
  const second=await readlink(path.join(f.data,'current'));
  assert.notEqual(second,first);
  assert.equal(await readFile(path.join(f.data,'current/mcp/scripts/cli.mjs'),'utf8'),'updated source');
  assert.equal((await lstat(path.join(f.data,first))).isDirectory(),true);
  await writeFile(path.join(f.checkout,'scripts/build-release.mjs'),'process.exit(1);');
  assert.notEqual(f.run().status,0);
  assert.equal(await readlink(path.join(f.data,'current')),second);
});

test('explicit archives, versions and release origins bypass automatic source builds',async t=>{
  const f=await sourceFixture(t);
  await writeFile(path.join(f.checkout,'scripts/build-release.mjs'),'throw Error("must not build");');
  const archive=f.run(['--archive',f.file]);assert.equal(archive.status,0,archive.stderr);
  assert.doesNotMatch(archive.stdout,/Source checkout detected/);
  const fakeBin=path.join(f.root,'fake-bin');await mkdir(fakeBin);
  await writeFile(path.join(fakeBin,'curl'),'#!/bin/sh\nprintf "release requested\\n" >&2\nexit 22\n',{mode:0o755});
  for(const [args,env] of [[['--version','0.1.0'],{}],[[],{SUPPORTPAGES_CLI_RELEASE_URL:'https://releases.example.test'}]]) {
    const result=f.run(args,{...env,PATH:fakeBin+path.delimiter+process.env.PATH});
    assert.notEqual(result.status,0,JSON.stringify({args,env,result}));assert.match(result.stderr,/release requested/);
    assert.doesNotMatch(result.stdout+result.stderr,/Source checkout detected|must not build/);
  }
});

test('a downloaded installer installs from the default download domain and saves it for updates',async t=>{
  const f=await sourceFixture(t);
  await rm(path.join(f.checkout,'src'),{recursive:true});
  const fakeBin=path.join(f.root,'fake-bin');await mkdir(fakeBin);
  await writeFile(path.join(fakeBin,'curl'),`#!/bin/sh
url= output=
while [ "$#" -gt 0 ]; do
  case "$1" in https://*) url="$1" ;; -o) shift; output="$1" ;; esac
  shift
done
case "$url" in
  https://downloads.supportpages.io/latest.txt) printf '0.1.0\\n' ;;
  https://downloads.supportpages.io/0.1.0/$(basename "$TEST_ARCHIVE")) cp "$TEST_ARCHIVE" "$output" ;;
  https://downloads.supportpages.io/0.1.0/$(basename "$TEST_ARCHIVE").sha256) cp "$TEST_ARCHIVE.sha256" "$output" ;;
  *) echo "Unexpected download URL: $url" >&2; exit 22 ;;
esac
`,{mode:0o755});
  const result=f.run([],{PATH:fakeBin+path.delimiter+process.env.PATH,TEST_ARCHIVE:f.file});
  assert.equal(result.status,0,result.stderr);
  assert.doesNotMatch(result.stdout,/Source checkout detected/);
  assert.equal(JSON.parse(await readFile(path.join(f.data,'install.json'),'utf8')).release_url,'https://downloads.supportpages.io');
});

test('standalone installer supports paths with spaces and quotes, repeat installs, and a managed launcher',async t=>{
  const f=await archiveFixture(t);
  const first=install(f);assert.equal(first.status,0,first.stderr);
  assert.equal((await lstat(path.join(f.data,'current'))).isSymbolicLink(),true);
  const launcher=path.join(f.bin,'supportpages');
  const run=spawnSync(launcher,['--version'],{encoding:'utf8',env:{PATH:'/usr/bin:/bin'}});assert.equal(run.status,0,run.stderr);assert.equal(run.stdout.trim(),'0.1.0');
  const second=install(f);assert.equal(second.status,0,second.stderr);
  assert.match(await readFile(launcher,'utf8'),/SupportPages managed launcher/);
});

test('failed checksums, unsafe archives and unrelated executables preserve existing files',async t=>{
  const f=await archiveFixture(t);await mkdir(f.bin);await writeFile(path.join(f.bin,'supportpages'),'unrelated');
  assert.notEqual(install(f).status,0);assert.equal(await readFile(path.join(f.bin,'supportpages'),'utf8'),'unrelated');
  await writeFile(f.file+'.sha256','0'.repeat(64));assert.notEqual(install(f).status,0);
  const unsafe=await archiveFixture(t,'0.1.1',true);assert.notEqual(install(unsafe).status,0);
});

test('an upgrade switches the active version while keeping the previous release and user files',async t=>{
  const first=await archiveFixture(t),second=await archiveFixture(t,'0.1.1');
  assert.equal(install(first).status,0);
  await writeFile(path.join(first.data,'user-note'),'keep');
  const upgraded=install({...second,data:first.data,bin:first.bin});assert.equal(upgraded.status,0,upgraded.stderr);
  const run=spawnSync(path.join(first.bin,'supportpages'),['--version'],{encoding:'utf8'});assert.equal(run.stdout.trim(),'0.1.1');
  assert.equal((await lstat(path.join(first.data,'versions',`0.1.0-${process.platform}-${process.arch}`))).isDirectory(),true);
  assert.equal(await readFile(path.join(first.data,'user-note'),'utf8'),'keep');
});

test('a broken private runtime is rejected before replacing the active installation', async t => {
  const first = await archiveFixture(t), next = await archiveFixture(t, '0.1.1');
  assert.equal(install(first).status, 0);
  const current = await readlink(path.join(first.data, 'current'));
  await writeFile(path.join(next.root, 'supportpages/mcp/scripts/check-runtime.mjs'), 'fixture');
  await writeFile(path.join(next.root, 'supportpages/runtime/bin/node'), '#!/bin/sh\ncase "$1" in */check-runtime.mjs) exit 1 ;; *) printf "0.1.1\\n" ;; esac\n', { mode: 0o755 });
  await repack(next);
  const result = install({ ...next, data: first.data, bin: first.bin });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /bundled tools cannot run/);
  assert.equal(await readlink(path.join(first.data, 'current')), current);
  assert.equal(spawnSync(path.join(first.bin, 'supportpages'), ['--version'], { encoding: 'utf8' }).stdout.trim(), '0.1.0');
});

test('release and source receipts preserve canonical custom installation locations',async t=>{
  const f=await archiveFixture(t);
  assert.equal(install(f).status,0);
  const receipt=JSON.parse(await readFile(path.join(f.data,'install.json'),'utf8'));
  assert.equal(receipt.version,1);assert.equal(receipt.type,'release');
  assert.equal(receipt.data_dir,await realpath(f.data));
  assert.equal(receipt.bin_dir,await realpath(f.bin));
  assert.equal(receipt.release_url,'https://downloads.supportpages.io');
  const source=await sourceFixture(t);assert.equal(source.run().status,0);
  assert.equal(JSON.parse(await readFile(path.join(source.data,'install.json'),'utf8')).type,'local');
});

test('piped installer works without a controlling terminal and truncated scripts do no work',async t=>{
  const f=await archiveFixture(t),home=path.join(f.root,'home');await mkdir(home);
  const script=await readFile('install-cli.sh','utf8');
  const args=['-s','--','--archive',f.file,'--data-dir',f.data,'--bin-dir',f.bin];
  const env={...process.env,HOME:home,SHELL:'/bin/bash'};
  const truncated=spawnSync('bash',args,{input:script.slice(0,script.indexOf('echo \'Verifying')),env,encoding:'utf8',detached:true,timeout:10000});
  assert.notEqual(truncated.status,0);
  await assert.rejects(lstat(f.data),{code:'ENOENT'});
  const complete=spawnSync('bash',args,{input:script,env,encoding:'utf8',detached:true,timeout:10000});
  assert.equal(complete.status,0,complete.stderr);assert.doesNotMatch(complete.stdout,/Add supportpages/);
  assert.match(complete.stdout,/For this terminal/);assert.match(complete.stdout,/Get started\n\n  1\. Set up this computer, once +supportpages setup\n  2\. Then, in each project folder +supportpages init\n/);assert.match(complete.stdout,/Articles are saved in your project, with no account needed/);assert.doesNotMatch(complete.stdout,/\x1b/);
});

test('failed upgrade probes, checksums and concurrent installs retain the active version',async t=>{
  const first=await archiveFixture(t),second=await archiveFixture(t,'0.2.0');
  assert.equal(install(first).status,0);
  const pointer=await readlink(path.join(first.data,'current'));
  const receipt=await readFile(path.join(first.data,'install.json'),'utf8');
  const upgrade={...second,data:first.data,bin:first.bin};
  await writeFile(second.file+'.sha256','0'.repeat(64));assert.notEqual(install(upgrade).status,0);
  await writeFile(path.join(second.root,'supportpages/runtime/bin/node'),'#!/bin/sh\nexit 1\n',{mode:0o755});await repack(second);
  assert.notEqual(install(upgrade).status,0);
  await mkdir(path.join(first.data,'.install.lock'));
  const locked=install(upgrade);assert.notEqual(locked.status,0);assert.match(locked.stderr,/Another installer/);
  assert.equal(await readlink(path.join(first.data,'current')),pointer);
  assert.equal(await readFile(path.join(first.data,'install.json'),'utf8'),receipt);
});

test('installer rejects malformed latest pointers and failed downloads, and rechecks downgrades under its lock',async t=>{
  const first=await archiveFixture(t,'0.2.0'),older=await archiveFixture(t,'0.1.0');
  assert.equal(install(first).status,0);
  const pointer=await readlink(path.join(first.data,'current'));
  const fakeBin=path.join(first.root,'download-tools');await mkdir(fakeBin);
  await writeFile(path.join(fakeBin,'curl'),`#!/bin/sh
url= output=
while [ "$#" -gt 0 ]; do
  case "$1" in https://*) url="$1" ;; -o) shift; output="$1" ;; esac
  shift
done
case "$url" in
  */latest.txt) printf '%s\\n' "$TEST_LATEST" ;;
  *) [ "$TEST_DOWNLOAD_FAIL" = false ] || exit 22
     case "$url" in *.sha256) cp "$TEST_ARCHIVE.sha256" "$output" ;; *) cp "$TEST_ARCHIVE" "$output" ;; esac ;;
esac
`,{mode:0o755});
  const run=(latest,fail=false)=>spawnSync('bash',['install-cli.sh','--yes','--update','--data-dir',first.data,'--bin-dir',first.bin],{
    env:{...process.env,PATH:fakeBin+path.delimiter+process.env.PATH,SUPPORTPAGES_CLI_RELEASE_URL:'https://downloads.example/cli',TEST_LATEST:latest,TEST_ARCHIVE:older.file,TEST_DOWNLOAD_FAIL:String(fail)},encoding:'utf8',timeout:10000,
  });
  const invalid=run('0.1.0\ninvalid');assert.notEqual(invalid.status,0);assert.match(invalid.stderr,/Invalid release version/);
  const failed=run('0.3.0',true);assert.notEqual(failed.status,0);assert.match(failed.stderr,/Download failed/);
  const downgrade=run('0.1.0');assert.equal(downgrade.status,0,downgrade.stderr);assert.match(downgrade.stdout,/newer than the available release/);
  assert.equal(await readlink(path.join(first.data,'current')),pointer);
});

test('rerunning the installer adds an update receipt to an older managed installation',async t=>{
  const f=await archiveFixture(t);assert.equal(install(f).status,0);
  await rm(path.join(f.data,'install.json'));
  assert.equal(install(f).status,0);
  assert.equal(JSON.parse(await readFile(path.join(f.data,'install.json'),'utf8')).type,'release');
});

test('existing PATH configuration is not duplicated and --yes never changes the shell profile',async t=>{
  const f=await archiveFixture(t),home=path.join(f.root,'home');await mkdir(home);
  const profile=path.join(home,process.platform==='darwin'?'.bash_profile':'.bashrc');
  await mkdir(f.bin);const bin=await realpath(f.bin);
  const line=`export PATH='${bin.replaceAll("'", "'\\''")}':$PATH`;
  await writeFile(profile,line+'\n');
  const result=spawnSync('bash',['install-cli.sh','--yes','--archive',f.file,'--data-dir',f.data,'--bin-dir',f.bin],{env:{...process.env,HOME:home,SHELL:'/bin/bash'},encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/Open a new terminal/);
  assert.equal(await readFile(profile,'utf8'),line+'\n');
  const onPath=spawnSync('bash',['install-cli.sh','--yes','--archive',f.file,'--data-dir',f.data,'--bin-dir',f.bin],{env:{...process.env,HOME:home,PATH:bin+path.delimiter+process.env.PATH},encoding:'utf8',timeout:10000});
  assert.equal(onPath.status,0,onPath.stderr);assert.doesNotMatch(onPath.stdout,/For this terminal/);
});

test('PATH prompt accepts or declines through the controlling terminal and preserves symlinked profiles',async t=>{
  // pty.fork provides /dev/tty while the installed process keeps its normal shell.
  const python=`import os,pty,select,sys,time\npid,fd=pty.fork()\nif pid==0:\n try: os.close(os.open("/dev/tty",os.O_RDWR))\n except PermissionError:\n  print("TTY_ACCESS_DENIED",flush=True); os._exit(77)\n os.execvpe("bash",["bash"]+sys.argv[2:],os.environ)\noutput=b""\nanswered=False\nwhile True:\n ready,_,_=select.select([fd],[],[],10)\n if not ready: os.kill(pid,9); raise RuntimeError("Prompt timed out")\n try: chunk=os.read(fd,65536)\n except OSError: break\n if not chunk: break\n output+=chunk\n if b"[Y/n]:" in output and not answered:\n  os.write(fd,(sys.argv[1]+"\\n").encode()); answered=True\n_,status=os.waitpid(pid,0)\nsys.stdout.buffer.write(output)\nsys.exit(os.waitstatus_to_exitcode(status))\n`;
  for(const answer of ['y','n','linked']) {
    const f=await archiveFixture(t),home=path.join(f.root,'home');await mkdir(home);
    const profile=path.join(home,'.zshrc'),target=path.join(home,'shared-profile');
    if(answer==='linked') {await writeFile(target,'keep\n');await symlink(target,profile);}
    const result=spawnSync('python3',['-c',python,answer==='n'?'n':'y','install-cli.sh','--archive',f.file,'--data-dir',f.data,'--bin-dir',f.bin],{env:{...process.env,HOME:home,ZDOTDIR:home,SHELL:'/bin/zsh'},encoding:'utf8',timeout:15000});
    if(result.status===77 && result.stdout.includes("TTY_ACCESS_DENIED")) {t.skip("Sandbox denies opening /dev/tty; covered on release runners");return;}
    assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/Add supportpages/);
    if(answer==='y') assert.match(await readFile(profile,'utf8'),/# SupportPages Writer/);
    if(answer==='n') await assert.rejects(lstat(profile),{code:'ENOENT'});
    if(answer==='linked') {assert.match(result.stdout,/symlink/);assert.equal(await readFile(target,'utf8'),'keep\n');}
  }
});

test('renderer preparation failure stops promotion and a retry can finish the update', async t => {
  const first = await archiveFixture(t), next = await archiveFixture(t, '0.2.0');
  assert.equal(install(first).status, 0);
  const previous = await readlink(path.join(first.data, 'current'));
  await writeFile(path.join(next.root, 'supportpages/mcp/scripts/prepare-update.mjs'), 'fixture');
  await writeFile(path.join(next.root, 'supportpages/runtime/bin/node'), `#!/bin/sh
case "$1" in
  -e) exec '${process.execPath.replaceAll("'", "'\\''")}' "$@" ;;
  */prepare-update.mjs) exit "\${TEST_PREPARE_EXIT:-0}" ;;
  *) printf '0.2.0\\n' ;;
esac
`, { mode: 0o755 });
  await repack(next);
  const fakeBin = path.join(first.root, 'download-tools');
  await mkdir(fakeBin);
  await writeFile(path.join(fakeBin, 'curl'), `#!/bin/sh
url= output=
while [ "$#" -gt 0 ]; do
  case "$1" in https://*) url="$1" ;; -o) shift; output="$1" ;; esac
  shift
done
case "$url" in
  *.sha256) cp "$TEST_ARCHIVE.sha256" "$output" ;;
  *) cp "$TEST_ARCHIVE" "$output" ;;
esac
`, { mode: 0o755 });
  const update = exit => spawnSync('bash', ['install-cli.sh', '--yes', '--update', '--version', '0.2.0', '--data-dir', first.data, '--bin-dir', first.bin], {
    env: { ...process.env, PATH: fakeBin + path.delimiter + process.env.PATH, TEST_ARCHIVE: next.file, TEST_PREPARE_EXIT: String(exit) }, encoding: 'utf8', timeout: 10000,
  });
  assert.notEqual(update(1).status, 0);
  assert.equal(await readlink(path.join(first.data, 'current')), previous);
  const retry = update(0);
  assert.equal(retry.status, 0, retry.stderr);
  assert.notEqual(await readlink(path.join(first.data, 'current')), previous);
});
