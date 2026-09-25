import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './helpers.mjs';
import { runAgent, openAgent, agentCommand, agentActivity, agentProgressText } from '../scripts/lib/agent-runner.mjs';
import { Cancelled } from '../scripts/lib/terminal.mjs';
import { claudeWriterAgents } from '../dist/writer-agent.js';

test('interactive launches restrict the other SupportPages.io environment and keep it in manual recovery', async t => {
  for (const agent of ['claude', 'codex']) for (const disabledConnection of ['supportpages', 'supportpages-dev']) {
    const invocation = agentCommand(agent, { interactive: true, disabledConnection });
    const flag = agent === 'claude' ? '--disallowedTools' : '-c';
    const value = agent === 'claude' ? `mcp__${disabledConnection}` : `mcp_servers.${disabledConnection}.enabled=false`;
    assert.equal(invocation.args[invocation.args.indexOf(flag) + 1], value);
    const h = await harness(t, 'process.exitCode=1', agent);
    const messages = [];
    assert.equal(await openAgent({ ...h.options, disabledConnection, ui: { line: message => messages.push(message) } }), false);
    assert.ok(h.calls[0].args.includes(value));
    assert.ok(messages.join('\n').includes(value));
  }
});

async function harness(t, source, agent = 'codex', extras = {}) {
  const f = await fixture(t), calls = [], lines = [];
  const script = await f.ws.write('fake-agent.cjs', source);
  const options = { agent, workspace: f.root, prompt: 'Inspect this project\nDo not publish.',
    logPath: path.join(f.root, 'private-agent.log'), ui: { info: text => lines.push(text) },
    env: { PATH: process.env.PATH, HOME: f.root, SUPPORTPAGES_API_TOKEN: 'never-pass', ANTHROPIC_API_KEY: 'user-provider-auth' },
    spawnProcess: (command, args, settings) => { calls.push({ command, args, settings }); return spawn(process.execPath, [script], settings); }, ...extras };
  return { ...f, calls, lines, options };
}

test('both headless agents run as subprocesses with workspace, prompt and existing provider auth', async t => {
  for (const agent of ['claude', 'codex']) {
    const h = await harness(t, `let input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>{
      require('fs').writeFileSync('observed.json',JSON.stringify({input,cwd:process.cwd(),auth:process.env.ANTHROPIC_API_KEY,token:process.env.SUPPORTPAGES_API_TOKEN}));
      console.log(JSON.stringify(${agent === 'claude' ? "{type:'result',is_error:false}" : "{type:'turn.completed'}"}));});`, agent);
    await runAgent(h.options);
    assert.deepEqual(await h.ws.json('observed.json'), { input: h.options.prompt, cwd: h.root, auth: 'user-provider-auth' });
    assert.equal((await stat(h.options.logPath)).mode & 0o777, 0o600);
    assert.equal(h.calls[0].settings.detached, true);
    assert.deepEqual(h.calls[0].args, agent === 'claude'
      ? ['-p', '--verbose', '--output-format', 'stream-json', '--dangerously-skip-permissions', '--model', 'sonnet', '--effort', 'low']
      : ['exec', '-', '--json', '--dangerously-bypass-approvals-and-sandbox']);
    assert.match(h.lines[0], /Starting agent/);
    assert.match(h.lines.at(-1), /Agent finished; checking its outputs next/);
    assert.doesNotMatch(h.lines.join('\n'), /user-provider-auth|never-pass/);
  }
});

test('agent failure, malformed streams and missing completion cannot pass as success', async t => {
  for (const [agent, source] of [
    ['codex', `console.log('not-json')`], ['codex', `console.log(JSON.stringify({type:'thread.started'}))`],
    ['codex', `console.log(JSON.stringify({type:'turn.failed'}))`],
    ['codex', `console.log(JSON.stringify({type:'turn.completed'}));process.exitCode=1`],
    ['claude', `console.log(JSON.stringify({type:'result',is_error:true}))`],
    ['claude', `console.log(JSON.stringify({type:'result'}))`]
  ]) {
    const h = await harness(t, source, agent);
    await assert.rejects(runAgent(h.options), { code: 'agent_failed' });
  }
});

test('model and effort overrides reach both headless and interactive subprocesses', async t => {
  for (const agent of ['claude', 'codex']) {
    const h = await harness(t, `console.log(JSON.stringify(${agent === 'claude' ? "{type:'result',is_error:false}" : "{type:'turn.completed'}"}));`, agent,
      { model: 'custom-model', effort: 'high' });
    await runAgent(h.options);
    await openAgent(h.options);
    for (const call of h.calls) {
      assert.equal(call.args[call.args.indexOf('--model') + 1], 'custom-model');
      if (agent === 'claude') assert.equal(call.args[call.args.indexOf('--effort') + 1], 'high');
      else assert.equal(call.args[call.args.indexOf('-c') + 1], 'model_reasoning_effort="high"');
    }
  }
  for (const interactive of [true, false]) {
    const args = agentCommand('claude', { interactive, model: null, effort: null }).args;
    assert.ok(!args.includes('--model') && !args.includes('--effort'));
  }
  assert.throws(() => agentCommand('claude', { model: '--bad-flag' }), { code: 'invalid_configuration' });
  assert.throws(() => agentCommand('codex', { effort: 'unsupported' }), { code: 'invalid_configuration' });
});

test('a successful Claude result with historical permission denials proceeds to artifact validation', async t => {
  const h = await harness(t, `console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,num_turns:118,
    permission_denials:[{tool_name:'Bash',tool_input:{command:'PRIVATE_COMMAND'}},{tool_name:'Write'}]}));`, 'claude');
  await runAgent(h.options);
  assert.match(h.lines.at(-1), /Agent finished; checking its outputs next/);
  assert.doesNotMatch(h.lines.join('\n'), /PRIVATE_COMMAND|could not finish/);
});

test('live permission blocks stop the agent promptly instead of letting it retry around the denial', async t => {
  const h = await harness(t, `
    console.log(JSON.stringify({type:'system',subtype:'permission_denied',tool_name:'Read',message:'PRIVATE_PATH requires approval'}));
    setTimeout(()=>{require('fs').writeFileSync('retried-anyway','bad');console.log(JSON.stringify({type:'result',is_error:false}));},2000);
  `, 'claude');
  await assert.rejects(runAgent(h.options), { code: 'agent_permission_required' });
  assert.equal(await h.ws.exists('retried-anyway'), false);
  assert.match(h.lines.join('\n'), /Permission required/);
  assert.match(h.lines.at(-1), /Agent needs permission to continue/);
  assert.doesNotMatch(h.lines.join('\n'), /PRIVATE_PATH/);
  assert.equal(process.listenerCount('SIGINT'), 0);
});

test('a failed result with unresolved permission denials gives permission-specific recovery', async t => {
  const h = await harness(t, `console.log(JSON.stringify({type:'result',subtype:'error_during_execution',is_error:true,permission_denials:[{tool_name:'Bash'}]}));`, 'claude');
  await assert.rejects(runAgent(h.options), { code: 'agent_permission_required' });
});

test('timeouts terminate the process group and leave private diagnostics', async t => {
  const h = await harness(t, `console.error('private diagnostic');setInterval(()=>{},1000)`, 'codex', { timeoutMs: 200 });
  await assert.rejects(runAgent(h.options), { code: 'agent_timeout' });
  assert.match(await readFile(h.options.logPath, 'utf8'), /private diagnostic/);
  assert.equal(process.listenerCount('SIGINT'), 0);
});

test('interrupting a real agent subprocess releases signal handlers and reports cancellation', async t => {
  const h = await harness(t, `console.log(JSON.stringify({type:'item.started'}));setInterval(()=>{},1000)`);
  h.options.ui.info = () => process.emit('SIGINT');
  await assert.rejects(runAgent(h.options), Cancelled);
  assert.equal(process.listenerCount('SIGINT'), 0);
  assert.equal(process.listenerCount('SIGTERM'), 0);
});

test('a missing executable has actionable retry guidance', async t => {
  const h = await harness(t, '');
  h.options.spawnProcess = (_command, args, settings) => spawn('/nonexistent-supportpages-agent', args, settings);
  await assert.rejects(runAgent(h.options), { code: 'agent_unavailable' });
});

test('a batch cancellation signal stops a real subprocess without taking over terminal handlers', async t => {
  const h = await harness(t, `console.log(JSON.stringify({type:'turn.started'}));setInterval(()=>{},1000)`);
  const controller = new AbortController();
  const listeners = process.listenerCount('SIGINT');
  h.options.ui.info = () => controller.abort();
  await assert.rejects(runAgent({ ...h.options, manageTerminal: false, signal: controller.signal }), Cancelled);
  assert.equal(process.listenerCount('SIGINT'), listeners);
  assert.equal(h.calls.length, 1);
});

test('interactive handoff inherits the terminal and prints a safe manual fallback on failure', async t => {
  for (const agent of ['claude', 'codex']) {
    const permissionFlag = agent === 'claude' ? '--dangerously-skip-permissions' : '--dangerously-bypass-approvals-and-sandbox';
    const modelFlags = agent === 'claude' ? ['--model', 'sonnet', '--effort', 'low'] : [];
    const writerFlags = agent === 'claude' ? ['--agents', JSON.stringify(claudeWriterAgents)] : [];
    assert.deepEqual(agentCommand(agent, { interactive: true, prompt: 'Write this' }), { command: agent, args: [...modelFlags, ...writerFlags, 'Write this'] });
    const h = await harness(t, 'process.exitCode=1', agent);
    const messages = [];
    const result = await openAgent({ ...h.options, ui: { line: text => messages.push(text) } });
    assert.equal(result, false);
    assert.deepEqual(h.calls[0].args, [...modelFlags, ...writerFlags, h.options.prompt]);
    assert.equal(h.calls[0].settings.stdio, 'inherit');
    assert.match(messages[0], /Open your coding agent manually/);
    assert.ok(!messages[0].includes(permissionFlag));
    assert.ok(messages[0].includes(h.options.prompt));
  }
});

test('interactive Claude sessions register a branded writer with inherited model and permissions', () => {
  const invocation = agentCommand('claude', { interactive: true, prompt: 'Write an article' });
  const agents = JSON.parse(invocation.args[invocation.args.indexOf('--agents') + 1]);
  assert.deepEqual(Object.keys(agents), ['supportpages-io']);
  assert.equal(agents['supportpages-io'].model, 'inherit');
  assert.equal(agents['supportpages-io'].permissionMode, undefined);
  assert.equal(agents['supportpages-io'].isolation, undefined);
  assert.match(agents['supportpages-io'].prompt, /without worktree isolation/);
  assert.equal(invocation.args.at(-1), 'Write an article');
  assert.ok(!agentCommand('claude').args.includes('--agents'));
  assert.ok(!agentCommand('codex', { interactive: true }).args.includes('--agents'));
});

test('progress shows observed activity and quiet time without displaying private agent output', async t => {
  const h = await harness(t, `
    console.log(JSON.stringify({type:'turn.started'}));
    console.log(JSON.stringify({type:'item.started',item:{type:'command_execution',command:'bash compile_css.sh PRIVATE_SOURCE'}}));
    console.log(JSON.stringify({type:'item.completed',item:{type:'command_execution',aggregated_output:'PRIVATE_OUTPUT'}}));
    console.log(JSON.stringify({type:'turn.completed'}));
  `);
  const messages = [], stops = [];
  h.options.ui.progress = text => { messages.push(text); return { update: text => messages.push(text), stop: (...args) => stops.push(args) }; };
  await runAgent(h.options);
  assert.match(messages.join('\n'), /Starting agent/);
  assert.match(messages.join('\n'), /Preparing project styles/);
  assert.match(messages.join('\n'), /Reviewing command results/);
  assert.doesNotMatch(messages.join('\n'), /PRIVATE|compile_css/);
  assert.equal(stops.length, 1); assert.equal(stops[0][1], 'success');
  assert.match(stops[0][0], /checking its outputs next/);
  assert.equal(agentActivity({type:'assistant',message:{content:[{type:'tool_use',name:'Write',input:{file_path:'/private/summary.md'}}]}}), 'Writing the product summary');
  assert.equal(agentActivity({type:'assistant',message:{content:[{type:'thinking',thinking:'PRIVATE'}]}}), undefined);
  assert.equal(agentActivity({type:'system',subtype:'thinking_tokens',estimated_tokens:50}), 'Analysing the project');
  assert.match(agentProgressText('claude', 'Reading project files', 125000, 23000), /Claude Code · Reading project files · 2:05 elapsed · Last update 23s ago · Ctrl\+C/);
  assert.doesNotMatch(agentProgressText('codex', 'Reading project files', 4000, 1000), /Last update/);
});

test('progress is stopped on cancellation, timeout and failed agent completion', async t => {
  for (const mode of ['cancel', 'timeout', 'failure']) {
    const h = await harness(t, mode === 'failure' ? `console.log(JSON.stringify({type:'turn.failed'}))` : `setInterval(()=>{},1000)`, 'codex', { timeoutMs: 150 });
    const stops = [];
    h.options.ui.progress = () => {
      if (mode === 'cancel') process.emit('SIGINT');
      return { update() {}, stop: (...args) => stops.push(args) };
    };
    await assert.rejects(runAgent(h.options));
    assert.equal(stops.length, 1);
    assert.equal(stops[0][1], mode === 'cancel' ? 'cancelled' : 'error');
    assert.doesNotMatch(stops[0][0], /checking its outputs/);
  }
});

test('Ctrl+C stops a live progress run in a real terminal and permits another prompt', async t => {
  const f = await fixture(t);
  const agent = await f.ws.write('waiting-agent.cjs', `setInterval(()=>{},1000);`);
  const script = await f.ws.write('terminal-progress.mjs', `
    import {spawn} from 'node:child_process';
    import {runAgent} from ${JSON.stringify(path.resolve('scripts/lib/agent-runner.mjs'))};
    import {createTerminal,Cancelled} from ${JSON.stringify(path.resolve('scripts/lib/terminal.mjs'))};
    const ui=createTerminal();
    try {
      await runAgent({agent:'codex',workspace:${JSON.stringify(f.root)},prompt:'Analyse',env:process.env,
        logPath:${JSON.stringify(path.join(f.root, 'progress.log'))},ui,
        spawnProcess:(_cmd,_args,options)=>spawn(process.execPath,[${JSON.stringify(agent)}],options)});
      throw Error('Expected cancellation');
    } catch(error) { if(!(error instanceof Cancelled)) throw error; }
    if(process.stdin.isRaw) throw Error('Terminal left in raw mode');
    if(!await ui.confirm('Resume later?',true)) throw Error('Next prompt failed');
    console.log('TERMINAL_RESTORED');
  `);
  const python = `
import os,pty,select,subprocess,sys,time,fcntl,termios,struct
master,slave=pty.openpty()
fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',24,100,0,0))
p=subprocess.Popen([sys.argv[1],sys.argv[2]],stdin=slave,stdout=slave,stderr=slave,env={**os.environ,'TERM':'xterm-256color','NO_COLOR':'1'})
os.close(slave)
buf=b''; stage=0; deadline=time.time()+8
try:
    while time.time()<deadline:
        if select.select([master],[],[],0.1)[0]:
            try: buf+=os.read(master,8192)
            except OSError: break
        if stage==0 and b'Ctrl+C to cancel' in buf:
            os.write(master,b'\\x03'); stage=1
        if stage==1 and b'Resume later?' in buf:
            os.write(master,b'y\\r'); stage=2
        if p.poll() is not None: break
    p.wait(timeout=2)
    assert p.returncode==0,repr(buf)
    assert b'TERMINAL_RESTORED' in buf,repr(buf)
    assert b'Agent stopped' in buf,repr(buf)
    assert b'checking its outputs next' not in buf,repr(buf)
finally:
    if p.poll() is None:p.kill()
    os.close(master)
`;
  const result = spawnSync('python3', ['-c', python, process.execPath, script], { encoding: 'utf8', timeout: 12000 });
  assert.equal(result.status, 0, result.stderr);
});
