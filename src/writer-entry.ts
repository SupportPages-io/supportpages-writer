import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Workspace } from './workspace.js';
import { Runs, runSchema } from './runs.js';
import { bindingSchema, contextSchema } from './schema.js';
import { parse, snapshot } from './artifacts.js';
import { fail, publicError, SupportPagesError } from './errors.js';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { writerReportingInstruction } from './writer-agent.js';

/** Screenshots per locally written article. The engine treats this as a hard
 * limit (RTFM_MAX_IMAGES); each mockup costs minutes of model time. */
export const writerScreenshotLimit = 3;

const recovery = 'Return to the main agent. Before drafting, call supportpages_status and supportpages_prepare_article, or supportpages_retry_article for an existing stopped run. Pass the returned task brief to SupportPages.io. Do not generate from a bare topic or bypass this check by reading the engine directly.';

export function writerEntry(workspace: string, stateRoot: string, runId: string, skillsDir: string, writerToken?: string) {
  const command = process.execPath;
  const args = [fileURLToPath(import.meta.url), workspace, stateRoot, runId, skillsDir, ...(writerToken ? [writerToken] : [])];
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const shell_command = [command, ...args].map(quote).join(' ');
  const execution = { command, args: [...args, '--exec'], shell_command: `${shell_command} --exec`,
    instruction: `Run every generation, rendering and validation command through this prefix: ${shell_command} --exec <executable> <arguments...>. It loads this attempt's saved environment and runs in the application directory. For shell variables, pipes or multiple commands, use ${shell_command} --exec /bin/sh -c '<script>' so variables expand inside the configured child shell. RTFM_WORKSPACE, RTFM_CONTEXT_FILE, RTFM_OUTPUT_DIR, RTFM_SKILLS_DIR, RTFM_MAX_IMAGES, OUT and the bundled runtime PATH are set automatically for every command. Do not rely on exports from a previous shell or manually reconstruct the environment.` };
  const completion = { command, args: [...args, '--complete'], shell_command: `${shell_command} --complete`, instruction: `After the entire writing, rendering and validation pipeline succeeds, run ${shell_command} --complete. No environment exports are needed. This signals successful writing and waits for the MCP to confirm final draft delivery. Stop editing artifacts after this command. Only report success when it returns ready_for_review, published or saved (saved means the article was written to a local folder with no editor link). If it fails or reports delivery_pending/upload_failed, relay its recovery instructions to the parent; do not claim delivery or regenerate. Do not ask the user to publish; the parent handles consent.` };
  return { command, args, shell_command, execution, completion, instruction: `Before reading generation skills or writing any content, run this complete command exactly as supplied: ${shell_command}. No environment exports are needed. This checks the prepared MCP run, records writer startup for live previews and prints the private article instructions and command wrapper. Follow them only if the command succeeds. If it fails, stop and relay its specific error to the main agent.` };
}

/** Local workflow gate, not a security boundary: the writer retains normal filesystem access. */
async function checkedWriter(args: string[]) {
  const [workspace, stateRoot, runId, skillsDir, writerToken] = args;
  if (![4, 5].includes(args.length) || !workspace || !stateRoot || !runId || !skillsDir ||
      !/^\.rtfm\/supportpages(?:\/dev\/[a-f0-9]{16})?$/.test(stateRoot)) fail('invalid_run', 'Missing prepared run arguments.');
  const ws = await Workspace.create(workspace);
  const runs = new Runs(ws, stateRoot);
  const run = await runs.read(runId);
  const contextPath = `${stateRoot}/runs/${runId}/context.json`;
  const context = parse(contextSchema, await ws.json(contextPath));
  if (run.writer_token !== writerToken) fail('stale_writer', 'This command does not match the current writer attempt. Use the latest task brief from the parent.');
  if (run.project_id) {
    const binding = parse(bindingSchema, await ws.json(`${stateRoot}/binding.json`));
    if (run.project_id !== binding.project_id || run.api_origin !== binding.api_origin || context.project.id !== binding.project_id) {
      fail('destination_mismatch', 'The prepared article no longer matches the connected help centre. Return to the parent to check the project connection.');
    }
  } else if (!context.local || !await ws.exists(`${stateRoot}/local.json`) || await ws.exists(`${stateRoot}/binding.json`)) {
    // A run prepared for local saving must still be in a folder that saves locally.
    fail('destination_mismatch', 'The prepared article was written for local saving, but this folder now has a help centre. Return to the parent to prepare it again.');
  }
  // Saved, validated state is authoritative; inherited RTFM_* values may belong
  // to another article, or may be absent in a fresh agent shell.
  const environment = {
    RTFM_CONTEXT_FILE: await ws.resolve(contextPath),
    RTFM_WORKSPACE: await ws.resolve(run.codebase_dir ?? '.'),
    RTFM_OUTPUT_DIR: await ws.resolve(run.artifact_dir),
    // Engine commands resolve their scripts through this, not a home-directory shortcut.
    RTFM_SKILLS_DIR: skillsDir,
    RTFM_MAX_IMAGES: String(writerScreenshotLimit),
  };
  return { ws, runs, run, stateRoot, skillsDir, environment };
}

async function activeWriter(args: string[]) {
  const checked = await checkedWriter(args);
  const { ws, run, stateRoot } = checked;
  const active = parse(runSchema, await ws.json(`${stateRoot}/active-run.json`));
  if (active.id !== run.id || run.status !== 'prepared' || run.writer_completed_at ||
      !['prepared', 'writing'].includes(run.phase ?? 'prepared')) {
    fail('writer_not_active', 'This writer is stopped, replaced or already finished. Return to the parent and check supportpages_status.');
  }
  return checked;
}

async function writerLock<T>(args: string[], operation: () => Promise<T>) {
  if (!args[0]) fail('invalid_run', 'Missing prepared workspace.');
  const ws = await Workspace.create(args[0]);
  // Retry only lock acquisition; never remove another process's lock.
  const deadline = Date.now() + 35_000;
  for (;;) {
    try { return await ws.lock(operation); }
    catch (error) {
      if ((error as { code?: string }).code !== 'workspace_busy' || Date.now() >= deadline) throw error;
      await delay(100);
    }
  }
}

// The optional environment argument remains accepted for older in-process callers.
export async function loadWriterInstructions(args: string[], _env?: NodeJS.ProcessEnv) {
  try {
    return await writerLock(args, async () => {
      const { ws, runs, run, stateRoot, skillsDir, environment } = await activeWriter(args);
      const skill = path.join(skillsDir, 'generate-illustrated-article', 'SKILL.md');
      let instructions: string;
      try { instructions = await readFile(skill, 'utf8'); }
      catch { fail('missing_dependency', 'The installed article instructions could not be read. Repair the skills installation before retrying this command.'); }
      if (!run.writer_started_at) await runs.save({ ...run, phase: 'writing', writer_started_at: new Date().toISOString() });
      const entrypoint = writerEntry(ws.root, stateRoot, run.id, skillsDir, run.writer_token);
      const reporting = writerReportingInstruction(run.execution_mode ? run.execution_mode === 'background' : run.prefer_background === true);
      return `SupportPages.io prepared run: ${run.id}\nEngine file: ${skill}\nResolve relative engine scripts and resources against ${path.dirname(skill)}.\nUse RTFM_OUTPUT_DIR as OUT and RTFM_CONTEXT_FILE for this run. The main agent handles all MCP calls.\nApplication directory: ${environment.RTFM_WORKSPACE}\nArticle output directory: ${environment.RTFM_OUTPUT_DIR}\nContext file: ${environment.RTFM_CONTEXT_FILE}\n\nReporting policy (takes precedence over routine progress requests in the engine):\n${reporting}\n\nRequired command wrapper:\n${entrypoint.execution.instruction}\n\n${instructions}\n\nRequired execution and final handoff:\n${entrypoint.execution.instruction}\n${entrypoint.completion.instruction}\n${reporting}\n`;
    });
  } catch (error) {
    const safe = publicError(error);
    fail(safe.code, `SupportPages.io writer entry check failed: ${safe.message} ${recovery}`);
  }
}

/** Each command gets its own prepared environment; no shell state must survive
 * between agent tool calls. Release the state lock before running so the relay
 * can continue delivering previews. The host still owns stopping old writers. */
export async function runWriterCommand(args: string[], command: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (!command[0]) fail('invalid_command', 'Append an executable and its arguments after --exec.');
  const { environment, run } = await writerLock(args, () => activeWriter(args));
  if (!run.writer_started_at) fail('writer_not_started', 'Run the supplied writer entrypoint before executing article commands.');
  const childEnv: NodeJS.ProcessEnv = { ...env, ...environment, OUT: environment.RTFM_OUTPUT_DIR,
    PWD: environment.RTFM_WORKSPACE, PATH: path.dirname(process.execPath) + path.delimiter + (env.PATH ?? '') };
  delete childEnv.SUPPORTPAGES_API_TOKEN;
  delete childEnv.SUPPORTPAGES_API_TOKEN_FILE;
  const child = spawn(command[0], command.slice(1), { cwd: environment.RTFM_WORKSPACE, env: childEnv, stdio: 'inherit', detached: process.platform !== 'win32' });
  const signalGroup = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal); }
    catch { child.kill(signal); }
  };
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  let interrupted: NodeJS.Signals | undefined;
  const stop = (signal: NodeJS.Signals) => {
    interrupted = signal;
    signalGroup(signal);
    forceTimer ??= setTimeout(() => signalGroup('SIGKILL'), 1500);
  };
  const onInterrupt = () => stop('SIGINT'), onTerminate = () => stop('SIGTERM');
  process.on('SIGINT', onInterrupt); process.on('SIGTERM', onTerminate);
  try {
    return await new Promise<number>((resolve, reject) => {
      child.once('error', () => reject(new SupportPagesError('command_unavailable', 'The writer command could not start. Check its executable and installation.')));
      child.once('close', (code, signal) => resolve(interrupted ? 128 + constants.signals[interrupted] : code ?? (signal ? 128 + constants.signals[signal] : 1)));
    });
  } finally {
    clearTimeout(forceTimer);
    if (interrupted) signalGroup('SIGKILL');
    process.off('SIGINT', onInterrupt); process.off('SIGTERM', onTerminate);
  }
}

/** Explicit writer success; no API credentials or network requests in this process. */
export async function requestWriterCompletion(args: string[], _env?: NodeJS.ProcessEnv) {
  return writerLock(args, async () => {
    const { ws, runs, run, stateRoot } = await checkedWriter(args);
    if (!run.writer_token) fail('invalid_run', 'Use the finish command from the current task brief.');
    if (run.remote && ['ready_for_review', 'published'].includes(run.phase ?? '')) return run;
    if (run.phase === 'saved' && run.status === 'finalized') return run;
    const active = parse(runSchema, await ws.json(`${stateRoot}/active-run.json`));
    if (active.id !== run.id || run.status !== 'prepared' || run.phase !== 'writing') {
      if (run.writer_completed_at && run.status === 'finalized') return run;
      fail('invalid_run', 'This writer is not running. Return to the parent and check supportpages_status.');
    }
    if (!run.writer_completed_at) {
      // Share final bundle checks with complete_article. A full set of preview
      // images alone cannot signal success, nor can stale or failed validation.
      await snapshot(ws, run.artifact_dir, run.started_at);
      await runs.save({ ...run, writer_completed_at: new Date().toISOString() });
    }
    return runs.read(run.id);
  });
}

export async function finishWriter(args: string[], env: NodeJS.ProcessEnv, timeoutMs = 125_000) {
  const requested = await requestWriterCompletion(args, env);
  const ws = await Workspace.create(args[0]!);
  const runs = new Runs(ws, args[1]!);
  const recovery = requested.project_id
    ? `The parent must call supportpages_complete_article with run_id=${requested.id} and completed=true. Do not regenerate, mark the writer failed or claim the editor is ready until delivery is confirmed.`
    : `The parent must call supportpages_complete_article with run_id=${requested.id} and completed=true to save the article. Do not regenerate or mark the writer failed.`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = await runs.read(requested.id);
    if (run.writer_token !== requested.writer_token) fail('invalid_run', 'This writer was replaced. Return to the parent without changing the new attempt.');
    if (run.phase === 'saved' && run.export_path) {
      return { status: 'saved', run_id: run.id, markdown_path: run.export_path,
        instructions: 'The article is saved locally; there is no editor link. Return this result to the parent. The parent must call supportpages_complete_article for the final user-facing response; the writer must not ask to publish.' };
    }
    if (run.remote && ['ready_for_review', 'published'].includes(run.phase ?? '')) {
      return { status: run.remote.status === 'published' ? 'published' : 'ready_for_review', run_id: run.id, editor_url: run.remote.editor_url,
        instructions: 'Final delivery is confirmed. Return this result to the parent. The parent must call supportpages_complete_article for the final user-facing response and publication consent; the writer must not ask to publish.' };
    }
    if (run.error) fail(run.phase === 'upload_failed' ? 'upload_failed' : run.error.code, `${run.error.message} ${recovery}`);
    if (['failed', 'interrupted', 'cancelled'].includes(run.status)) fail('invalid_run', 'This run has stopped. Return to the parent and check supportpages_status.');
    if (Date.now() >= deadline) fail('delivery_pending', `The MCP has not confirmed final delivery. ${recovery}`);
    await delay(250);
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  try {
    const execute = args.indexOf('--exec');
    if (execute !== -1) process.exitCode = await runWriterCommand(args.slice(0, execute), args.slice(execute + 1));
    else process.stdout.write(args.at(-1) === '--complete'
      ? JSON.stringify(await finishWriter(args.slice(0, -1), process.env)) + '\n'
      : await loadWriterInstructions(args, process.env));
  } catch (error) {
    const safe = publicError(error);
    process.stderr.write(`${safe.code}: ${(error as Error).message}\n`); process.exitCode = 1;
  }
}
