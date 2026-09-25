import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { LocalSetup, cacheFiles, projectCacheFiles } from '../../dist/local-setup.js';
import { fail, publicError } from '../../dist/errors.js';
import { runAgent, openAgent } from './agent-runner.mjs';
import { ensureWriterAvailable } from './writer-recovery.mjs';
import { Cancelled } from './terminal.mjs';
import { availableAgents, readAgentSettings, executionSettings, modelDescription } from './agent-settings.mjs';

const clean = value => String(value).replace(/[\p{Cc}\p{Cf}]/gu, '');
const label = agent => agent === 'claude' ? 'Claude Code' : 'Codex';

export class Planning {
  constructor(session, options, deps, clients = []) {
    this.session = session; this.options = options; this.deps = deps; this.ui = deps.ui; this.clients = clients;
  }
  async initialize() {
    this.bridge = await this.session.bridge();
    this.store = new LocalSetup(this.bridge.ws, this.bridge.stateRoot);
    this.destination = await this.bridge.destination();
    if (this.destination === 'none') fail('project_required', 'Run supportpages init to set up this folder first.');
    this.projectId = this.destination === 'hosted' ? (await this.bridge.binding()).project_id : undefined;
    return this;
  }
  /** Remote project context, or the folder's own context when it saves articles locally. */
  projectContext() { return this.bridge.contextFor(this.destination); }
  async chooseAgent() {
    if (this.agent) return this.agent;
    const settingsFile = `${this.bridge.stateRoot}/setup/settings.json`;
    const saved = await readAgentSettings(this.bridge);
    const available = await availableAgents(this.session, this.deps, this.clients);
    const preferred = this.options.agent ?? saved.agent;
    if (this.options.agent && !available.includes(this.options.agent)) fail('agent_unavailable', 'The selected coding agent is not installed and connected. Run supportpages init.');
    this.agent = available.includes(preferred) ? preferred : available.length === 1 ? available[0] : await this.ui.choose('Which agent should analyse and plan this project?', available.map(value => ({ value, label: label(value) })));
    await this.bridge.ws.writeJson(settingsFile, { ...saved, agent: this.agent });
    return this.agent;
  }
  /**
   * Explain the analysis, then run it now or later. With one agent this is a yes/no
   * question; with both, the answer also picks the agent (Claude Code first).
   * Returns the agent to run with, or undefined to defer.
   */
  async analysisAgent() {
    const saved = await readAgentSettings(this.bridge);
    const connected = await availableAgents(this.session, this.deps, this.clients);
    if (this.options.agent && !connected.includes(this.options.agent)) fail('agent_unavailable', 'The selected coding agent is not installed and connected. Run supportpages init.');
    const available = this.options.agent ? [this.options.agent] : connected;
    const models = await Promise.all(available.map(async agent => modelDescription(agent, await executionSettings(this.bridge, agent))));
    this.ui.note?.(`SupportPages Writer reads this project once to map its screens, styles and branding, and writes a short product summary. Every article starts from it.\nIt runs in your coding agent with your existing account and takes about 5 minutes.\n\n${models.join('\n')}`, 'Project analysis');
    let agent;
    if (available.length === 1) {
      if (!await this.ui.confirm(`Run the analysis now with ${label(available[0])}?`, true)) return;
      agent = available[0];
    } else {
      const ordered = [...available].sort((a, b) => (b === 'claude') - (a === 'claude'));
      agent = await this.ui.choose('Run the analysis now?', [
        ...ordered.map(value => ({ value, label: `Yes, with ${label(value)}`, ...(value === 'claude' ? { hint: 'Recommended' } : {}) })),
        { value: 'later', label: 'Later', hint: 'Run supportpages analyse when you are ready' },
      ], Math.max(0, ordered.indexOf(saved.agent)));
      if (agent === 'later') return;
    }
    this.agent = agent;
    await this.bridge.ws.writeJson(`${this.bridge.stateRoot}/setup/settings.json`, { ...saved, agent });
    return agent;
  }
  async context() {
    const remote = await this.projectContext();
    if (remote.inventory_truncated) fail('inventory_truncated', 'The help-centre inventory is too large for a complete local planning pass.');
    const analysis = await this.store.requireAnalysis();
    return { ...remote, ...remote.product_context, user_context: remote.product_context ?? {}, project_name: remote.project.name,
      project_overview: analysis.overview, analysis_summary: analysis.summary };
  }

  async task(skill, context, extra = '') {
    const agent = await this.chooseAgent();
    const settings = await executionSettings(this.bridge, agent);
    const ws = this.bridge.ws;
    const directory = `${this.bridge.stateRoot}/setup/tasks/${randomUUID()}`;
    const contextPath = await ws.writeJson(`${directory}/context.json`, context);
    const output = await ws.resolve(directory);
    const previous = await this.store.analysis();
    if (previous.status === 'ready' && await ws.exists(`${previous.output_dir}/file_tree.txt`)) await ws.write(`${directory}/file_tree.txt`, await ws.read(`${previous.output_dir}/file_tree.txt`));
    let instructions;
    try { instructions = await readFile(path.join(this.session.options.skillsDir, skill, 'SKILL.md'), 'utf8'); }
    catch { fail('missing_dependency', `The ${skill} skill is missing. Run supportpages init to repair the installation.`); }
    const receipt = { version: 1, skill, agent, workspace: ws.root, output_dir: directory, status: 'running', started_at: new Date().toISOString() };
    this.activeTask = receipt;
    await ws.writeJson(`${this.bridge.stateRoot}/setup/task.json`, receipt);
    const targetContract = skill === 'detect-project' ? `\n\nLocal setup output contract: Write ${output}/analysis-target.json containing {"codebase_dir":"."} when analysing the workspace root, or the actual workspace-relative application directory (for example {"codebase_dir":"apps/web"}) when analysing a nested application. Keep branding.json, project_map.json and branding.css in that application's .rtfm directory. Do not copy its cache into the parent: source paths are relative to the application. Write summary.md and overview.txt in ${output}. Before reporting success, verify all five files exist and contain valid output, including when reusing an existing cache. Record the selected directory even when invoking the skill through the Skill tool.` : '';
    const prompt = `Run the ${skill} skill for this local project. Complete the task and write its output files; do not generate articles, publish, or call SupportPages.io MCP tools.\nIf a required tool or file access needs permission, stop and report the block. Do not work around permission denials by copying scripts or switching tools.\nWorkspace: ${ws.root}\nEngine root: ${this.session.options.skillsDir} (exported as RTFM_SKILLS_DIR, which the skill paths use).\nContext: ${contextPath}\nOutput directory: ${output}\n${extra}\n\n${instructions}${targetContract}`;
    const env = { ...this.deps.env, RTFM_WORKSPACE: ws.root, RTFM_CONTEXT_FILE: contextPath, RTFM_OUTPUT_DIR: output,
      RTFM_ANALYZE: skill === 'detect-project' ? 'full' : '', RTFM_SKILLS_DIR: this.session.options.skillsDir };
    try {
      await (this.deps.runAgent ?? runAgent)({ agent, ...settings, workspace: ws.root, prompt, ui: this.ui,
        env,
        logPath: await ws.resolve(`${directory}/agent.log`) });
      return { directory, receipt };
    } catch (error) {
      await ws.writeJson(`${this.bridge.stateRoot}/setup/task.json`, { ...receipt, status: error instanceof Cancelled ? 'cancelled' : 'failed', error: publicError(error), finished_at: new Date().toISOString() });
      if (['agent_failed', 'agent_unavailable', 'agent_timeout', 'agent_permission_required'].includes(error.code)) {
        this.ui.line(publicError(error).message);
        const action = await this.ui.choose('Continue this setup stage?', [
          { value: 'interactive', label: `Open ${label(agent)} to finish interactively`, hint: 'Sign in or approve tools in your agent, then exit when finished.' },
          { value: 'stop', label: 'Stop and retry later' }]);
        if (action === 'interactive') {
          await ws.writeJson(`${this.bridge.stateRoot}/setup/task.json`, receipt);
          if (await (this.deps.openAgent ?? openAgent)({ agent, ...settings, workspace: ws.root, prompt, env, ui: this.ui })) {
            // The caller still validates every output; exiting the agent is not success.
            return { directory, receipt };
          }
        }
      }
      await ws.writeJson(`${this.bridge.stateRoot}/setup/task.json`, { ...receipt, status: error instanceof Cancelled ? 'cancelled' : 'failed', error: publicError(error), finished_at: new Date().toISOString() });
      throw error;
    }
  }
  async finish(task) {
    await this.bridge.ws.writeJson(`${this.bridge.stateRoot}/setup/task.json`, { ...task.receipt, status: 'completed', finished_at: new Date().toISOString() });
    this.activeTask = undefined;
  }
  async failedTask(error) {
    if (!this.activeTask) return;
    await this.bridge.ws.writeJson(`${this.bridge.stateRoot}/setup/task.json`, { ...this.activeTask,
      status: error instanceof Cancelled ? 'cancelled' : 'failed', error: publicError(error), finished_at: new Date().toISOString() });
    this.activeTask = undefined;
  }
  async sourceCommit(codebaseDir = '.') {
    const result = await this.deps.run('git', ['rev-parse', 'HEAD'], { cwd: await this.bridge.ws.resolve(codebaseDir), capture: true });
    return result.code === 0 && /^[a-f0-9]{40,64}$/.test(result.stdout?.trim() ?? '') ? result.stdout.trim() : null;
  }
  async recoverAnalysis() {
    const ws = this.bridge.ws;
    const file = `${this.bridge.stateRoot}/setup/task.json`;
    if (!await ws.exists(file)) return;
    const task = await ws.json(file);
    if (task.skill !== 'detect-project' || task.status !== 'failed' || task.workspace !== ws.root || typeof task.output_dir !== 'string') return;
    if (!task.output_dir.startsWith(`${this.bridge.stateRoot}/setup/tasks/`)) return;
    const candidates = [];
    try { candidates.push((await this.store.validate(task.output_dir)).codebase_dir); }
    catch {
      // Legacy runs did not record their chosen application. Offer only complete
      // immediate-child caches, then let the user identify the intended product.
      if (await ws.exists(`${task.output_dir}/analysis-target.json`)) return;
      for (const entry of (await ws.list('.')).slice(0, 200)) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || ['node_modules', 'vendor', 'output'].includes(entry.name)) continue;
        try { await this.store.validate(task.output_dir, entry.name); candidates.push(entry.name); } catch { /* Incomplete or unsafe cache. */ }
      }
    }
    if (!candidates.length) return;
    this.ui.note?.((await ws.read(`${task.output_dir}/overview.txt`)).toString(), 'Previous analysis');
    const selected = candidates.length === 1
      ? await this.ui.confirm(`Reuse the completed analysis for ${clean(candidates[0])}?`, true) ? candidates[0] : undefined
      : await this.ui.choose('Which application was analysed?', [...candidates.map(value => ({ value, label: clean(value) })), { value: '', label: 'Run analysis again' }]);
    if (!selected) return;
    await this.store.accept(task.output_dir, task.agent, await this.bridge.version(), await this.sourceCommit(selected), selected);
    await this.finish({ receipt: task });
    this.ui.ok(`Recovered project analysis from ${clean(selected)}.`);
    return this.store.requireAnalysis();
  }
  async analyse(refresh = false, hint = this.options['app-type'], correction = '') {
    const ws = this.bridge.ws;
    let result, previousReady = false;
    for (;;) {
      try {
        await ws.lock(async () => {
          const existing = await this.store.analysis();
          previousReady = existing.status === 'ready';
          // Detection that stopped short names the app type it needs; use it rather
          // than making the user repeat what the map already asked for.
          if (!hint && !previousReady && existing.app_type) {
            hint = existing.app_type;
            this.ui.line(`The saved project map is incomplete and asks for app_type=${hint}. Detecting again with that app type.`);
          }
          const commit = await this.sourceCommit(existing.status === 'ready' ? existing.codebase_dir : '.');
          if (existing.status === 'ready' && !refresh && commit && existing.source_commit && existing.source_commit !== commit) {
            refresh = await this.ui.confirm('This checkout has changed since analysis. Refresh it now?', false);
          }
          if (existing.status === 'ready' && !refresh) {
            // Say which analysis is in use and how to redo it, so a stale cache is
            // never a silent surprise.
            this.ui.line(`Using the project analysis from ${clean(existing.completed_at?.slice(0, 10) ?? 'an earlier run')}. Rerun with supportpages ${this.options.command === 'init' ? 'init' : 'analyse'} --refresh to redo it.`);
            result = existing;
            return;
          }
          await this.bridge.runs.assertAvailable();
          if (!refresh) { result = await this.recoverAnalysis(); if (result) return; }
          if (!refresh && await ws.exists('output/detect-project/summary.md')) {
            try { await this.store.accept('output/detect-project', 'existing cache', await this.bridge.version()); result = await this.store.requireAnalysis(); return; }
            catch { /* Incomplete legacy detection needs a full run. */ }
          }
          if (!await this.analysisAgent()) return;
          this.ui.info?.('Loading project context…');
          const backup = new Map();
          const restoreFiles = [...new Set([...cacheFiles, ...(existing.status === 'ready' ? projectCacheFiles(existing.codebase_dir) : []), `${this.bridge.stateRoot}/setup/analysis.json`])];
          for (const file of restoreFiles) if (await ws.exists(file)) backup.set(file, await ws.read(file, 10 * 1024 * 1024));
          let task, validation;
          try {
            const context = await this.projectContext();
            task = await this.task('detect-project', { ...context, ...context.product_context, project_name: context.project.name }, `RTFM_ANALYZE=full: summary.md and overview.txt are mandatory. ${hint ? `Explicit app_type=${hint}.` : ''} ${correction ? `User correction: ${correction}` : ''}`);
            validation = this.ui.progress?.('Checking analysis files…');
            const target = await this.store.validate(task.directory);
            await this.store.accept(task.directory, this.agent, await this.bridge.version(), await this.sourceCommit(target.codebase_dir), target.codebase_dir);
            await this.finish(task);
            result = await this.store.requireAnalysis();
            validation?.stop('Analysis files checked and saved.');
          } catch (error) {
            validation?.stop('Analysis files could not be validated.', 'error');
            for (const file of restoreFiles) {
              if (backup.has(file)) await ws.write(file, backup.get(file));
              else await rm(await ws.resolve(file), { force: true });
            }
            await this.failedTask(error);
            if (task && error.code === 'missing_artifact') fail('invalid_analysis', `Project analysis did not produce all required files: ${publicError(error).message}. The summary and agent log are saved in ${task.directory}. Rerun supportpages init to recover a completed nested-application analysis or try again.`, { output_dir: task.directory });
            if (error instanceof Cancelled || error.code) throw error;
            fail('invalid_analysis', 'The analysis is incomplete or invalid. Run supportpages analyse --refresh to retry; the previous valid cache was kept.');
          }
        });
        break;
      } catch (error) {
        if (error.code !== 'generation_active') throw error;
        await ensureWriterAvailable(this.bridge, this.ui);
      }
    }
    if (!result) {
      this.ui.outro?.(previousReady
        ? 'Refresh deferred. Your previous analysis is still ready. Run supportpages analyse --refresh when you want to update it.'
        : 'Analysis deferred. Your project settings are saved.\nRun supportpages analyse when you are ready; articles need it first.');
      return;
    }
    this.ui.note?.(`${clean(result.overview)}\n\nApplication: ${clean(result.codebase_dir)}\nApp type: ${clean(result.app_type)}\nFramework: ${clean(result.framework)}`, 'Project analysis');
    this.ui.ok('Project analysis is ready.');
    return result;
  }
  async reviewAnalysis() {
    return Boolean(await this.analyse(Boolean(this.options.refresh || this.options['app-type'])));
  }
  async write() {
    await this.store.requireAnalysis();
    await ensureWriterAvailable(this.bridge, this.ui);
    const agent = await this.chooseAgent();
    const connection = this.session.options.dev ? 'supportpages-dev' : 'supportpages';
    const other = this.session.options.dev ? 'supportpages' : 'supportpages-dev';
    let disabledConnection = agent === 'claude' ? other : undefined;
    if (agent === 'codex') {
      // An enabled-only entry for a missing server is invalid Codex config.
      const existing = await this.deps.run('codex', ['mcp', 'get', other, '--json'], { cwd: this.bridge.ws.root, capture: true });
      if (existing.code === 0 && existing.stdout?.trim()) disabledConnection = other;
    }
    const prompt = this.destination === 'local'
      ? `Use the ${connection} MCP connection for this project (${this.session.options.origin}). Project detection is complete. This project saves articles locally as Markdown and screenshots; there is no help centre and no sign-in is needed. Ask me which single article I want to write, then create it using SupportPages.io: call supportpages_prepare_article before writing and supportpages_complete_article after successful generation, then show where the article was saved. Do not upload, publish or start sign-in automatically. If I explicitly ask to host the saved articles, use supportpages_publish. Do not run the retired planning skills (suggest-sections, recommend-articles); running detect-project again is allowed and required when the project map is missing, stale or reports an incomplete detection.`
      : `Use the ${connection} MCP connection for this project (${this.session.options.origin}). Project detection is complete. Ask me which single article I want to write, then create it using SupportPages.io. Use supportpages_prepare_article before writing and supportpages_complete_article after successful generation. Return the draft review link. Do not publish automatically. Sections, topic suggestions and PR analysis are available in the web app after connecting a repository, so do not run the retired planning skills (suggest-sections, recommend-articles). Running detect-project again is allowed and required when the project map is missing, stale or reports an incomplete detection.`;
    this.ui.outro?.(`Opening ${label(agent)} in this project.`);
    return (this.deps.openAgent ?? openAgent)({ agent, ...await executionSettings(this.bridge, agent), workspace: this.bridge.ws.root, prompt, env: this.deps.env, ui: this.ui, disabledConnection });
  }
  async menu() {
    await ensureWriterAvailable(this.bridge, this.ui);
    this.ui.ok('Ready to write.');
    const agent = await this.chooseAgent();
    this.ui.outro?.(`Open ${label(agent)} in this project and ask for an article, for example: “Write an illustrated guide to inviting a teammate.” Restart ${label(agent)} first if it was already open.`);
  }
}
