import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import readline from 'node:readline';
import { modelSettings } from './agent-settings.mjs';
import { Cancelled } from './terminal.mjs';
import { fail } from '../../dist/errors.js';
import { claudeWriterAgents } from '../../dist/writer-agent.js';

// Display observed activity, never raw commands, agent prose or reasoning.
export function agentActivity(event) {
  const commandActivity = command => {
    if (/classify_app_type\.(sh|js)/.test(command ?? '')) return 'Detecting app type';
    if (/detect_static\.js/.test(command ?? '')) return 'Detecting project branding';
    if (/(compile_css\.sh|run_css_build\.sh|check_css_health\.js)/.test(command ?? '')) return 'Preparing project styles';
    if (/(detect_structure\.js|apply_runtime_profiles\.js)/.test(command ?? '')) return 'Mapping project structure';
    return 'Running project commands';
  };
  if (event.type === 'system' && event.subtype === 'init' || event.type === 'turn.started') return 'Inspecting the project';
  if (event.type === 'system' && event.subtype === 'thinking_tokens') return 'Analysing the project';
  if (event.type === 'assistant') {
    const tool = event.message?.content?.find(item => item.type === 'tool_use');
    if (tool?.name === 'Bash') return commandActivity(tool.input?.command);
    if (['Read', 'Glob', 'Grep'].includes(tool?.name)) return 'Reading project files';
    if (['Write', 'Edit', 'MultiEdit'].includes(tool?.name)) return /(?:summary\.md|overview\.txt)$/.test(tool.input?.file_path ?? '') ? 'Writing the product summary' : 'Saving project files';
  }
  if (['item.started', 'item.updated', 'item.completed'].includes(event.type)) {
    if (event.item?.type === 'command_execution') return event.type === 'item.completed' ? 'Reviewing command results' : commandActivity(event.item.command);
    if (event.item?.type === 'file_change') return 'Saving project files';
    if (event.item?.type === 'agent_message') return 'Preparing the agent response';
    if (event.type === 'item.started') return 'Inspecting the project';
  }
}

export function agentProgressText(agent, activity, elapsedMs, quietMs = 0) {
  const seconds = Math.floor(elapsedMs / 1000);
  const elapsed = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  const quiet = quietMs >= 20000 ? ` · Last update ${Math.floor(quietMs / 1000)}s ago` : '';
  return `${agent === 'claude' ? 'Claude Code' : 'Codex'} · ${activity} · ${elapsed} elapsed${quiet} · Ctrl+C to cancel`;
}

export function agentCommand(agent, { interactive = false, prompt = '', model, effort, disabledConnection } = {}) {
  if (!['claude', 'codex'].includes(agent)) fail('invalid_agent', 'Choose Claude Code or Codex.');
  if (disabledConnection !== undefined && !['supportpages', 'supportpages-dev'].includes(disabledConnection)) fail('invalid_configuration', 'Invalid SupportPages.io connection.');
  const permissionFlag = agent === 'claude' ? '--dangerously-skip-permissions' : '--dangerously-bypass-approvals-and-sandbox';
  ({ model, effort } = modelSettings(agent, { model, effort }));
  const flags = [...(interactive ? [] : [permissionFlag]), ...(model ? ['--model', model] : []),
    ...(disabledConnection ? agent === 'claude' ? ['--disallowedTools', `mcp__${disabledConnection}`] : ['-c', `mcp_servers.${disabledConnection}.enabled=false`] : []),
    ...(effort ? agent === 'claude' ? ['--effort', effort] : ['-c', `model_reasoning_effort=${JSON.stringify(effort)}`] : [])];
  if (interactive) return { command: agent, args: [...flags, ...(agent === 'claude' ? ['--agents', JSON.stringify(claudeWriterAgents)] : []), prompt] };
  return agent === 'claude'
    ? { command: 'claude', args: ['-p', '--verbose', '--output-format', 'stream-json', ...flags] }
    : { command: 'codex', args: ['exec', '-', '--json', ...flags] };
}

/** Run locally with the user's auth and permission checks bypassed. */
export async function runAgent({ agent, model, effort, workspace, prompt, env, logPath, ui, timeoutMs = 15 * 60_000, spawnProcess = spawn, signal, manageTerminal = true }) {
  if (signal?.aborted) throw new Cancelled();
  const invocation = agentCommand(agent, { model, effort });
  const log = await open(logPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const childEnv = { ...env };
  delete childEnv.SUPPORTPAGES_API_TOKEN;
  delete childEnv.SUPPORTPAGES_API_TOKEN_FILE;
  let child, interrupted = false, timedOut = false, streamError = false, permissionBlocked = false, failed = false, completed = false, buffer = '', logBytes = 0;
  let forceTimer, timer, heartbeat, progress, agentFinished = false, logWork = Promise.resolve();
  const started = Date.now();
  let activity = 'Starting agent', lastEvent = started, lastRendered = started;
  const progressText = () => agentProgressText(agent, activity, Date.now() - started, Date.now() - lastEvent);
  const render = (isHeartbeat = false) => {
    if (progress) progress.update(progressText(), { heartbeat: isHeartbeat });
    else if (!isHeartbeat || Date.now() - lastRendered >= 15000) { ui.info?.(progressText()); lastRendered = Date.now(); }
  };
  const record = text => {
    if (logBytes > 8 * 1024 * 1024) return;
    logBytes += Buffer.byteLength(text);
    logWork = logWork.then(() => log.write(text)).catch(() => { streamError = true; });
  };
  const signalGroup = signal => {
    if (!child?.pid) return;
    try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch {} }
  };
  const stop = () => { signalGroup('SIGTERM'); forceTimer ??= setTimeout(() => signalGroup('SIGKILL'), 1500); };
  const cancel = () => { interrupted = true; stop(); };
  const keypress = (_text, key) => { if (key?.ctrl && ['c', 'd'].includes(key.name)) cancel(); };
  const input = process.stdin;
  const wasRaw = Boolean(input.isRaw), wasFlowing = input.readableFlowing === true;
  try {
    child = spawnProcess(invocation.command, invocation.args, { cwd: workspace, env: childEnv, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    if (manageTerminal) { process.once('SIGINT', cancel); process.once('SIGTERM', cancel); }
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    if (manageTerminal && input.isTTY && input.setRawMode) {
      readline.emitKeypressEvents(input);
      input.setRawMode(true); input.on('keypress', keypress); input.resume();
    }
    timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    heartbeat = setInterval(() => render(true), 1000);
    const event = line => {
      if (!line.trim()) return;
      let value;
      try { value = JSON.parse(line); } catch { streamError = true; return; }
      if (!value || typeof value !== 'object' || Array.isArray(value)) { streamError = true; return; }
      lastEvent = Date.now();
      if (value.type === 'system' && value.subtype === 'permission_denied') {
        // Headless mode cannot ask for approval. Stop promptly and let the user
        // approve in their interactive agent, rather than retrying other tools.
        permissionBlocked = true; activity = 'Permission required'; render(); stop();
      }
      if (value.type === 'result') {
        completed = true;
        // permission_denials is historical: a successful run may have recovered.
        // Success still requires the caller's artifact validation.
        failed ||= value.is_error === true || (value.is_error !== false && value.subtype !== 'success');
        if (failed && value.permission_denials?.length > 0) permissionBlocked = true;
      }
      if (value.type === 'turn.completed') completed = true;
      if (['turn.failed', 'error'].includes(value.type)) failed = true;
      const nextActivity = agentActivity(value);
      if (nextActivity && nextActivity !== activity) { activity = nextActivity; render(); }
    };
    child.stdout.on('data', chunk => {
      const text = chunk.toString(); record(text); buffer += text;
      if (buffer.length > 1024 * 1024) { streamError = true; stop(); return; }
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) { event(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); }
    });
    child.stderr.on('data', chunk => record(chunk.toString()));
    child.stdin.on('error', () => {}); // EPIPE is reported through the child's final status.
    const done = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    progress = ui.progress?.(progressText());
    if (!progress) render();
    child.stdin.end(prompt);
    let result;
    try { result = await done; }
    catch { fail('agent_unavailable', `Could not start ${agent}. Check its installation, sign in, and retry.`); }
    if (buffer.trim()) event(buffer);
    await logWork;
    if (interrupted) throw new Cancelled();
    if (permissionBlocked) fail('agent_permission_required', 'Claude Code needs tool or file-access approval to continue. Open it interactively to review the requested permissions. Your completed setup steps are kept.');
    if (timedOut) fail('agent_timeout', 'The agent timed out. Completed setup steps are saved; retry this stage.');
    if (result.code !== 0 || failed || !completed || streamError) fail('agent_failed', `The agent could not complete this stage. Open ${agent} in this project to check authentication and permissions, then retry. Private diagnostics: ${logPath}`);
    agentFinished = true;
  } finally {
    clearTimeout(timer); clearTimeout(forceTimer); clearInterval(heartbeat);
    // Kill remaining descendants after cancellation, even if the leader exited first.
    if (interrupted || timedOut || streamError || permissionBlocked) signalGroup('SIGKILL');
    if (manageTerminal) {
      process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
      input.off('keypress', keypress);
      if (input.isTTY && input.setRawMode) { input.setRawMode(wasRaw); if (!wasFlowing) input.pause(); }
    }
    signal?.removeEventListener('abort', cancel);
    const elapsed = Math.floor((Date.now() - started) / 1000);
    const message = `${interrupted ? 'Agent stopped' : permissionBlocked ? 'Agent needs permission to continue' : timedOut ? 'Agent timed out' : agentFinished ? 'Agent finished; checking its outputs next' : 'Agent could not finish'} · ${elapsed}s elapsed`;
    if (progress) progress.stop(message, interrupted ? 'cancelled' : agentFinished ? 'success' : 'error');
    else ui.info?.(message);
    await logWork; await log.close();
  }
}

export async function openAgent({ agent, model, effort, workspace, prompt, env, ui, disabledConnection, spawnProcess = spawn }) {
  const { command, args } = agentCommand(agent, { interactive: true, prompt, model, effort, disabledConnection });
  try {
    const child = spawnProcess(command, args, { cwd: workspace, env, stdio: 'inherit' });
    const ignoreInterrupt = () => {}; // Foreground agent owns the terminal while it is open.
    process.on('SIGINT', ignoreInterrupt);
    try {
      const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
      if (code !== 0) throw Error('Agent exited');
    } finally { process.off('SIGINT', ignoreInterrupt); }
    return true;
  } catch {
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
    const manualCommand = [command, ...args.slice(0, -1)].map(quote).join(' ');
    ui.line(`Open your coding agent manually:\ncd ${quote(workspace)}\n${manualCommand}\n\nThen paste:\n${prompt}`);
    return false;
  }
}
