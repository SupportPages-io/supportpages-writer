import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { rename, symlink, rm } from 'node:fs/promises';
import { loadWriterInstructions, requestWriterCompletion } from '../dist/writer-entry.js';
import { Workspace } from '../dist/workspace.js';
import { Bridge } from '../dist/bridge.js';
import { LocalSetup } from '../dist/local-setup.js';
import { fixture, seedAnalysis } from './helpers.mjs';
import { writerPermissionInstruction } from '../dist/writer-agent.js';

async function prepared(t) {
  const f = await fixture(t);
  await f.bridge.bind('1');
  await seedAnalysis(f.ws);
  const run = await f.bridge.prepare({ title: 'Invite', article_type: 'how-to' });
  return { ...f, run, brief: run.task_brief };
}
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('RTFM_') && key !== 'OUT'));
const invoke = (brief, { invocation = brief.entrypoint, env = cleanEnv(), extra = [], shell = false } = {}) => new Promise((resolve, reject) => {
  const child = shell ? spawn('/bin/sh', ['-c', invocation.shell_command], { env, cwd: '/' })
    : spawn(invocation.command, [...invocation.args, ...extra], { env, cwd: '/' });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
  child.on('error', reject); child.on('close', status => resolve({ status, stdout, stderr }));
});

test('foreground and background entrypoints preserve native approvals through failed-writer recovery', async t => {
  const f = await prepared(t);
  for (const mode of ['background', 'foreground']) {
    const handoff = mode === 'background' ? f.run : await f.bridge.retryArticle({ run_id: f.run.run_id, stopped: true });
    const brief = handoff.task_brief;
    await f.bridge.updateRun({ run_id: f.run.run_id, event: 'started', execution_mode: mode });
    const entry = await invoke(brief);
    assert.equal(entry.status, 0, entry.stderr);
    assert.ok(entry.stdout.includes(writerPermissionInstruction));
    assert.ok(brief.writer_instructions.includes(writerPermissionInstruction));
    assert.doesNotMatch(entry.stdout, /Report a failure or permission block promptly.*then stop/);
    // A sandbox-style command failure returns its diagnostics without marking the run complete.
    const blocked = await invoke(brief, { invocation: brief.execution, extra: ['/bin/sh', '-c', 'echo "Operation not permitted" >&2; exit 1'] });
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /Operation not permitted/);
    const pending = await f.bridge.runs.read(f.run.run_id);
    assert.equal(pending.phase, 'writing');
    assert.equal(pending.writer_completed_at, undefined);
    if (mode === 'background') {
      // Parent records a stopped blocked writer; foreground retry obtains a fresh attempt.
      await f.bridge.updateRun({ run_id: f.run.run_id, event: 'failed', stopped: true });
      assert.equal((await f.bridge.runs.read(f.run.run_id)).phase, 'failed');
    } else {
      // Host approval can retry the command in this still-active attempt.
      const approved = await invoke(brief, { invocation: brief.execution, extra: ['/bin/sh', '-c', 'echo resumed'] });
      assert.equal(approved.status, 0);
      assert.equal(approved.stdout.trim(), 'resumed');
      await assert.rejects(requestWriterCompletion(brief.entrypoint.args.slice(1)), /./);
    }
  }
});

test('finish signal requires an active matching writer and complete validated output', async t => {
  const f = await prepared(t), args = f.brief.entrypoint.args.slice(1);
  await assert.rejects(requestWriterCompletion(args, f.brief.environment), { code: 'invalid_run' });
  await invoke(f.brief);
  await assert.rejects(requestWriterCompletion(args, f.brief.environment));
  await f.output();
  await f.ws.writeJson(`${f.run.artifact_dir}/lint_report.json`, { all_passed: false });
  await assert.rejects(requestWriterCompletion(args, f.brief.environment), { code: 'quality_check_failed' });
  assert.equal((await f.bridge.runs.read(f.run.run_id)).writer_completed_at, undefined);
  await f.output();
  const result = await requestWriterCompletion(args, { RTFM_OUTPUT_DIR: '/wrong' });
  assert.ok(result.writer_completed_at);
  assert.equal((await requestWriterCompletion(args, f.brief.environment)).writer_completed_at, result.writer_completed_at);
  assert.equal((await invoke(f.brief)).status, 1, 'a finished writer cannot restart edits');
  await f.bridge.updateRun({ run_id: f.run.run_id, event: 'interrupted', stopped: true });
  const retry = await f.bridge.retryArticle({ run_id: f.run.run_id, stopped: true });
  assert.equal((await f.bridge.runs.read(f.run.run_id)).writer_completed_at, undefined);
  await assert.rejects(requestWriterCompletion(args, f.brief.environment), /does not match/);
  assert.equal((await invoke(retry.task_brief)).status, 0);
});

test('writer entry records actual startup once and allows later host execution metadata', async t => {
  const f = await prepared(t);
  const before = await f.bridge.runs.read(f.run.run_id);
  const result = await invoke(f.brief);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /fixture/);
  assert.match(result.stdout, /Use RTFM_OUTPUT_DIR as OUT/);
  const started = await f.bridge.runs.read(f.run.run_id);
  assert.equal(started.phase, 'writing');
  assert.ok(started.writer_started_at);
  assert.equal(started.first_writer_started_at, started.writer_started_at);
  assert.equal(started.session_id, before.session_id);
  assert.equal(started.execution_mode, undefined);
  assert.equal(started.host_task_id, undefined);
  assert.deepEqual(await f.ws.json(`${f.bridge.stateRoot}/active-run.json`), started);
  assert.equal((await invoke(f.brief)).status, 0);
  assert.deepEqual(await f.bridge.runs.read(f.run.run_id), started);
  assert.equal(await f.ws.exists(f.run.artifact_dir), false);
  await assert.rejects(f.bridge.cancel(f.run.run_id), { code: 'writer_not_stopped' });
  await f.bridge.updateRun({ run_id: f.run.run_id, event: 'started', execution_mode: 'foreground' });
  assert.equal((await invoke(f.brief)).status, 0);
  await assert.rejects(f.bridge.updateRun({ run_id: f.run.run_id, event: 'started', execution_mode: 'background', host_task_id: 'replacement' }), { code: 'writer_not_stopped' });
});

test('startup derives its configuration with no exports or with stale inherited environment', async t => {
  const f = await prepared(t);
  for (const env of [cleanEnv(), { ...cleanEnv(), RTFM_OUTPUT_DIR: '/tmp/wrong',
    RTFM_WORKSPACE: '/tmp/wrong', RTFM_CONTEXT_FILE: '/tmp/wrong' }]) {
    const result = await invoke(f.brief, { env, shell: true });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Required command wrapper/);
    assert.ok(result.stdout.includes(f.brief.environment.RTFM_CONTEXT_FILE));
  }
});

test('direct entry and missing or mismatched saved context stop before exposing engine instructions', async t => {
  const f = await prepared(t);
  const args = f.brief.entrypoint.args.slice(1);
  await assert.rejects(loadWriterInstructions(args.slice(0, 4), f.brief.environment), /entry check failed/);
  assert.equal((await f.bridge.runs.read(f.run.run_id)).phase, 'prepared');
  assert.equal((await f.bridge.runs.read(f.run.run_id)).writer_started_at, undefined);
  await assert.rejects(loadWriterInstructions([], {}), /Return to the main agent/);
  const result = spawnSync(f.brief.entrypoint.command, [f.brief.entrypoint.args[0]], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /supportpages_prepare_article/);
  assert.equal(await f.ws.exists(f.run.artifact_dir), false);
  const contextPath = `${f.bridge.stateRoot}/runs/${f.run.run_id}/context.json`;
  const context = await f.ws.json(contextPath);
  await f.ws.writeJson(contextPath, { ...context, project: { ...context.project, id: '2' } });
  await assert.rejects(loadWriterInstructions(args), { code: 'destination_mismatch' });
  await rm(await f.ws.resolve(contextPath));
  await assert.rejects(loadWriterInstructions(args), { code: 'missing_artifact' });
  assert.equal((await f.bridge.runs.read(f.run.run_id)).writer_started_at, undefined);
});

test('every wrapped command restores the environment, runtime and cwd in a fresh shell', async t => {
  const f = await prepared(t);
  const options = { invocation: f.brief.execution, env: { ...cleanEnv(), PATH: '/missing', RTFM_WORKSPACE: '/wrong',
    RTFM_OUTPUT_DIR: '/wrong', RTFM_CONTEXT_FILE: '/wrong', OUT: '/wrong', SUPPORTPAGES_API_TOKEN: 'not-for-writer', SUPPORTPAGES_API_TOKEN_FILE: '/private' },
    extra: ['/bin/sh', '-c', 'node -e \'console.log(JSON.stringify({cwd:process.cwd(),exe:process.execPath,workspace:process.env.RTFM_WORKSPACE,context:process.env.RTFM_CONTEXT_FILE,output:process.env.RTFM_OUTPUT_DIR,out:process.env.OUT,token:process.env.SUPPORTPAGES_API_TOKEN,tokenFile:process.env.SUPPORTPAGES_API_TOKEN_FILE}))\''] };
  const premature = await invoke(f.brief, options);
  assert.equal(premature.status, 1);
  assert.match(premature.stderr, /writer_not_started/);
  assert.equal((await invoke(f.brief)).status, 0);
  for (let i = 0; i < 2; i++) {
    const result = await invoke(f.brief, options);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { cwd: f.brief.workspace, exe: process.execPath,
      workspace: f.brief.environment.RTFM_WORKSPACE, context: f.brief.environment.RTFM_CONTEXT_FILE,
      output: f.brief.environment.RTFM_OUTPUT_DIR, out: f.brief.environment.RTFM_OUTPUT_DIR });
  }
  const failed = await invoke(f.brief, { invocation: f.brief.execution, extra: ['/bin/sh', '-c', 'echo diagnostic >&2; exit 7'] });
  assert.equal(failed.status, 7);
  assert.match(failed.stderr, /diagnostic/);
  const absent = await invoke(f.brief, { invocation: f.brief.execution, extra: ['/missing-writer-command'] });
  assert.equal(absent.status, 1);
  assert.match(absent.stderr, /command_unavailable/);
  const noCommand = await invoke(f.brief, { invocation: f.brief.execution });
  assert.match(noCommand.stderr, /invalid_command/);
});

test('retries replace the command wrapper and completed writers cannot execute commands', async t => {
  const f = await prepared(t);
  const execute = brief => invoke(brief, { invocation: brief.execution, extra: [process.execPath, '-e', 'console.log("ran")'] });
  await invoke(f.brief);
  await f.bridge.updateRun({ run_id: f.run.run_id, event: 'failed', stopped: true });
  assert.match((await execute(f.brief)).stderr, /writer_not_active/);
  const retry = await f.bridge.retryArticle({ run_id: f.run.run_id, stopped: true });
  assert.deepEqual(retry.task_brief.execution, retry.task_brief.entrypoint.execution);
  assert.match((await execute(f.brief)).stderr, /stale_writer/);
  assert.equal((await invoke(retry.task_brief)).status, 0);
  assert.equal((await execute(retry.task_brief)).stdout.trim(), 'ran');
  await f.output();
  await requestWriterCompletion(retry.task_brief.entrypoint.args.slice(1));
  assert.match((await execute(retry.task_brief)).stderr, /writer_not_active/);
});

test('quoted launch commands and nested dev workspaces work without environment exports', async t => {
  const f = await fixture(t);
  const root = path.join(f.root, "app's folder $(touch SHOULD_NOT_EXIST); workspace");
  await f.ws.write("app's folder $(touch SHOULD_NOT_EXIST); workspace/placeholder", '');
  await rename(path.join(f.root, 'skills'), path.join(root, 'skills'));
  const nested = await Workspace.create(root);
  const bridge = new Bridge(nested, f.bridge.api, path.join(root, 'skills'), undefined, undefined, path.join(root, 'config'));
  bridge.api.dev = true;
  t.after(() => bridge.close());
  await bridge.bind('1');
  await seedAnalysis(nested, bridge.stateRoot);
  for (const name of ['branding.json', 'project_map.json', 'branding.css']) await nested.write(`apps/web/.rtfm/${name}`, await nested.read(`.rtfm/${name}`));
  await nested.writeJson('output/detect-project/analysis-target.json', { codebase_dir: 'apps/web' });
  await new LocalSetup(nested, bridge.stateRoot).accept('output/detect-project', 'fixture', '1.0.0');
  const prepared = await bridge.prepare({ title: 'Nested guide', article_type: 'how-to' });
  const brief = prepared.task_brief;
  assert.match(bridge.stateRoot, /^\.rtfm\/supportpages\/dev\//);
  assert.equal((await invoke(brief, { shell: true })).status, 0);
  const invocation = { ...brief.execution, shell_command: brief.execution.shell_command + ' /bin/sh -c \'printf "%s\\n" "$PWD" "$RTFM_CONTEXT_FILE" "$OUT" "$RTFM_MAX_IMAGES"\'' };
  const result = await invoke(brief, { invocation, shell: true });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), [path.join(root, 'apps/web'), brief.environment.RTFM_CONTEXT_FILE, brief.environment.RTFM_OUTPUT_DIR, '3']);
  assert.equal(await nested.exists('SHOULD_NOT_EXIST'), false);
});

test('unsafe saved paths and unreadable engine instructions retain specific startup errors', async t => {
  const f = await prepared(t), args = f.brief.entrypoint.args.slice(1);
  const run = await f.bridge.runs.read(f.run.run_id);
  await f.bridge.runs.save({ ...run, artifact_dir: '../escape' });
  await assert.rejects(loadWriterInstructions(args), { code: 'invalid_path' });
  await f.bridge.runs.save(run);
  await symlink('/tmp', path.join(f.root, '.rtfm/supportpages/work'));
  await assert.rejects(loadWriterInstructions(args), { code: 'invalid_path' });
  await rm(path.join(f.root, '.rtfm/supportpages/work'));
  await rm(path.join(f.root, 'skills/generate-illustrated-article/SKILL.md'));
  await assert.rejects(loadWriterInstructions(args), { code: 'missing_dependency' });
  assert.equal((await f.bridge.runs.read(f.run.run_id)).writer_started_at, undefined);
});

test('wrapped commands leave the state lock free and forward cancellation to their children', async t => {
  const f = await prepared(t);
  await invoke(f.brief);
  const { command, args } = f.brief.execution;
  const child = spawn(command, [...args, process.execPath, '-e',
    'process.on("SIGTERM",()=>{console.log("stopped");process.exit(0)});console.log("ready");setInterval(()=>{},1000)'],
    { env: cleanEnv(), cwd: '/', stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
  const exited = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => resolve(code)); });
  const deadline = Date.now() + 5000;
  while (!stdout.includes('ready')) {
    assert.equal(child.exitCode, null, stderr);
    assert.ok(Date.now() < deadline, 'wrapped child must start');
    await delay(20);
  }
  await f.bridge.lock(async () => {
    assert.equal((await f.bridge.runs.read(f.run.run_id)).phase, 'writing');
  });
  child.kill('SIGTERM');
  assert.equal(await exited, 143);
  assert.match(stdout, /stopped/);
  assert.equal((await f.bridge.runs.read(f.run.run_id)).writer_completed_at, undefined);
});

test('stopped or replaced runs cannot load the engine; MCP retry restores entry to the same article', async t => {
  const f = await prepared(t);
  await f.bridge.updateRun({ run_id: f.run.run_id, event: 'failed', stopped: true });
  assert.equal((await invoke(f.brief)).status, 1);
  const retry = await f.bridge.retryArticle({ run_id: f.run.run_id, stopped: true });
  assert.equal(retry.task_brief.run_id, f.run.run_id);
  assert.equal((await f.bridge.runs.read(f.run.run_id)).writer_started_at, undefined);
  assert.equal((await invoke(f.brief)).status, 1, 'the old entrypoint cannot start a new attempt');
  assert.equal((await f.bridge.runs.read(f.run.run_id)).phase, 'prepared');
  assert.equal((await invoke(retry.task_brief)).status, 0);
  await f.bridge.cancel(f.run.run_id, true);
  await f.bridge.prepare({ title: 'Another', article_type: 'how-to' });
  assert.equal((await invoke(f.brief)).status, 1);
});

test('entry waits for an active operation and rechecks cancellation before writing', async t => {
  const f = await prepared(t);
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let acquired;
  const locked = new Promise(resolve => { acquired = resolve; });
  const operation = f.bridge.lock(async () => {
    acquired();
    await held;
    const run = await f.bridge.runs.read(f.run.run_id);
    await f.bridge.runs.save({ ...run, status: 'cancelled', phase: 'cancelled' });
  });
  await locked;
  const entering = loadWriterInstructions(f.brief.entrypoint.args.slice(1), f.brief.environment);
  await delay(20);
  release();
  await operation;
  await assert.rejects(entering, /entry check failed/);
  const run = await f.bridge.runs.read(f.run.run_id);
  assert.equal(run.phase, 'cancelled');
  assert.equal(run.writer_started_at, undefined);
});

test('a changed project binding is rejected before writing', async t => {
  const f = await prepared(t);
  await f.ws.writeJson(`${f.bridge.stateRoot}/binding.json`, { version: 1, project_id: '2', api_origin: f.bridge.api.origin });
  const result = await invoke(f.brief);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(await f.ws.exists(f.run.artifact_dir), false);
});
