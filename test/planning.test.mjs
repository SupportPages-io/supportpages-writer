import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { fixture, seedAnalysis, context, article, png, remote as draftRemote } from './helpers.mjs';
import { Planning } from '../scripts/lib/planning.mjs';
import { Cancelled } from '../scripts/lib/terminal.mjs';
import { command } from '../scripts/lib/install.mjs';
import { Bridge } from '../dist/bridge.js';
import { ApiClient } from '../dist/api.js';

const proposed = { name: 'Team', slug: 'team', description: 'Work with your team', icon: 'users' };
const suggestion = { title: 'Invite a teammate', description: 'Send an invitation', type: 'how-to' };
async function planning(t, { analysed = true, remote = structuredClone(context), choices = [], options = {}, fetcher } = {}) {
  const requests = [], tasks = [], launches = [], lines = [];
  const f = await fixture(t, async (url, init) => {
    requests.push({ url, init });
    if (fetcher) { const result = await fetcher(url, init); if (result) return result; }
    if (url.endsWith('/sections')) return Response.json({ sections: JSON.parse(init.body).sections.map((s, i) => ({ ...s, id: String(i + 20) })) });
    return Response.json(remote);
  });
  await f.bridge.bind('1');
  if (analysed) await seedAnalysis(f.ws);
  for (const skill of ['detect-project', 'suggest-sections', 'recommend-articles']) await f.ws.write(`skills/${skill}/SKILL.md`, `Fixture ${skill} instructions`);
  // A real deterministic subprocess verifies the CLI invokes and checks the finalizer.
  await f.ws.write('skills/recommend-articles/scripts/finalize_intent_plan.js', `
    const fs=require('fs'),path=require('path'),a=process.argv.slice(2),args={};
    for(let i=0;i<a.length;i+=2)args[a[i]]=a[i+1];
    const plan=JSON.parse(fs.readFileSync(args['--plan']));
    fs.writeFileSync(path.join(args['--out'],'intent_plan_report.json'),JSON.stringify({all_passed:plan.valid}));
    if(!plan.valid)process.exit(1);
    fs.writeFileSync(path.join(args['--out'],'recommendations.json'),JSON.stringify(plan.recommendations));
  `);
  const ui = { info: text => lines.push(text), line: text => lines.push(text), ok: text => lines.push(text), note: text => lines.push(text), outro: text => lines.push(text),
    choose: async question => choices.shift() ?? (question === 'What would you like to do next?' ? 'write' : 'done'), confirm: async () => true, ask: async (_q, initial) => initial, multiselect: async (_q, _items, initial) => initial };
  const deps = { ui, env: { PATH: process.env.PATH },
    run: async (cmd, args, settings) => cmd === process.execPath ? command(cmd, args, settings) : { code: 0, stdout: '' },
    openAgent: async value => { launches.push(value); return true; },
    runAgent: async value => {
      tasks.push(value);
      const out = path.relative(f.root, value.env.RTFM_OUTPUT_DIR);
      if (value.prompt.includes('Run the detect-project skill')) {
        await f.ws.writeJson('.rtfm/branding.json', { framework: 'Rails' });
        await f.ws.writeJson('.rtfm/project_map.json', { framework: 'Rails', app_type: 'web', route_index: { home: {} } });
        await f.ws.write('.rtfm/branding.css', 'body { color: red; }');
        await f.ws.write(`${out}/summary.md`, 'An app for working together.');
        await f.ws.write(`${out}/overview.txt`, 'Team collaboration.');
        await f.ws.write(`${out}/file_tree.txt`, 'app/\nconfig/');
      } else if (value.prompt.includes('Run the suggest-sections skill')) {
        await f.ws.writeJson(`${out}/sections.json`, { sections: [proposed] });
        await f.ws.writeJson(`${out}/features.json`, { features: [{ name: 'Invite', description: 'Invite teammates', suggested_section_slug: 'team' }] });
      } else {
        const taskContext = await f.ws.json(path.relative(f.root, value.env.RTFM_CONTEXT_FILE));
        await f.ws.writeJson(`${out}/intent_plan.json`, { valid: true, recommendations: taskContext.sections.length ? { [taskContext.sections[0].slug]: [suggestion] } : { articles: [suggestion] } });
      }
    } };
  const session = { bridge: async () => f.bridge, options: { skillsDir: path.join(f.root, 'skills'), origin: f.bridge.api.origin } };
  const flow = await new Planning(session, { agent: 'codex', ...options }, deps).initialize();
  return { ...f, flow, deps, session, ui, tasks, requests, launches, lines, remote, choices };
}

test('writing restricts the opposite environment without inventing missing Codex registrations', async t => {
  for (const agent of ['claude', 'codex']) for (const dev of [false, true]) {
    const f = await planning(t, { options: { agent } });
    f.session.options.dev = dev;
    const previousRun = f.deps.run;
    const other = dev ? 'supportpages' : 'supportpages-dev';
    f.deps.run = async (cmd, args, options) => args?.[0] === 'mcp' && args[2] === other
      ? { code: 0, stdout: JSON.stringify({ name: other, transport: { type: 'stdio', command: 'node' } }) }
      : previousRun(cmd, args, options);
    await f.flow.write();
    assert.equal(f.launches.at(-1).disabledConnection, other);
    if (agent === 'codex') {
      f.deps.run = previousRun;
      await f.flow.write();
      assert.equal(f.launches.at(-1).disabledConnection, undefined);
    }
  }
});

test('fresh setup performs full analysis, reuses it, and leaves writing to the agent without optional planning', async t => {
  const f = await planning(t, { analysed: false, choices: ['write'] });
  await f.flow.reviewAnalysis(); await f.flow.menu();
  assert.equal(f.tasks.length, 1);
  assert.equal(f.tasks[0].env.RTFM_ANALYZE, 'full');
  assert.equal((await f.bridge.setup.analysis()).status, 'ready');
  assert.equal(f.launches.length, 0, 'init points to the coding agent instead of opening it');
  // The legacy write command still opens the agent with the article instructions.
  await f.flow.write();
  assert.equal(f.launches.length, 1);
  assert.match(f.launches[0].prompt, /Ask me which single article I want to write/);
  assert.match(f.launches[0].prompt, /Do not publish automatically/);
  assert.deepEqual((await f.bridge.setup.plan('1')).recommendations, []);
  await f.flow.analyse(); assert.equal(f.tasks.length, 1);
  assert.equal(f.requests.filter(r => r.init.method === 'POST').length, 0);
});

test('finishing after detection points to the coding agent instead of opening one or offering menus', async t => {
  const f = await planning(t);
  f.ui.confirm = async () => assert.fail('No prompt to open an agent');
  f.ui.choose = async () => assert.fail('No planning menu');
  await f.flow.menu();
  assert.equal(f.launches.length, 0);
  assert.equal(f.tasks.length, 0);
  assert.match(f.lines.join(' '), /Open Codex in this project and ask for an article/);
  assert.doesNotMatch(f.lines.join(' '), /supportpages write/);
});

test('ready analysis can be reused with an unfinished writer without changing its record', async t => {
  const f = await planning(t);
  const prepared = await f.bridge.prepare({ title: 'Invite', article_type: 'how-to' });
  await f.bridge.updateRun({ run_id: prepared.run_id, event: 'started', execution_mode: 'foreground' });
  const before = await f.bridge.runs.read(prepared.run_id);
  f.ui.choose = async () => assert.fail('Reusing analysis needs no writer recovery');
  f.ui.confirm = async () => assert.fail('Reusing analysis needs no confirmation');
  assert.equal(await f.flow.reviewAnalysis(), true);
  assert.equal(f.tasks.length, 0);
  assert.deepEqual(await f.bridge.runs.read(prepared.run_id), before);
});

test('analysis refresh recovers a stopped writer outside the lock and preserves article files', async t => {
  const f = await planning(t);
  const prepared = await f.bridge.prepare({ title: 'Invite', article_type: 'how-to' });
  await f.bridge.updateRun({ run_id: prepared.run_id, event: 'started', execution_mode: 'foreground' });
  await f.output();
  const before = await f.ws.read(`${prepared.artifact_dir}/article.json`);
  f.ui.choose = async (question, choices) => {
    assert.equal(question, 'How would you like to continue?');
    assert.deepEqual(choices.map(choice => choice.value), ['clear', 'keep']);
    assert.equal(await f.ws.exists('.rtfm/supportpages/operation.lock'), false);
    return 'clear';
  };
  await f.flow.analyse(true);
  assert.equal(f.tasks.length, 1);
  assert.equal((await f.bridge.runs.read(prepared.run_id)).status, 'cancelled');
  assert.deepEqual(await f.ws.read(`${prepared.artifact_dir}/article.json`), before);
  assert.equal((await f.bridge.prepare({ title: 'Another', article_type: 'how-to' })).status, 'prepared');
});

test('keeping an unfinished writer leaves its state intact and does not analyse or launch an agent', async t => {
  const f = await planning(t, { choices: ['keep', 'keep'] });
  const prepared = await f.bridge.prepare({ title: 'Invite', article_type: 'how-to' });
  const before = await f.bridge.runs.read(prepared.run_id);
  await assert.rejects(f.flow.analyse(true), Cancelled);
  await assert.rejects(f.flow.write(), Cancelled);
  assert.equal(f.tasks.length, 0);
  assert.equal(f.launches.length, 0);
  assert.deepEqual(await f.bridge.runs.read(prepared.run_id), before);
});

test('writer recovery rejects a run updated while the user is choosing', async t => {
  const f = await planning(t);
  const prepared = await f.bridge.prepare({ title: 'Invite', article_type: 'how-to' });
  f.ui.choose = async () => {
    await f.bridge.updateRun({ run_id: prepared.run_id, event: 'started', execution_mode: 'background', host_task_id: 'still-alive' });
    return 'clear';
  };
  await assert.rejects(f.flow.write(), { code: 'run_changed' });
  assert.equal((await f.bridge.runs.read(prepared.run_id)).phase, 'writing');
  assert.equal(f.launches.length, 0);
});

test('a writer in another connection stays protected and recovery identifies that connection', async t => {
  const f = await planning(t);
  const prepared = await f.bridge.prepare({ title: 'Invite', article_type: 'how-to' });
  const before = await f.bridge.runs.read(prepared.run_id);
  const dev = new Bridge(f.ws, new ApiClient('http://app.lvh.me:3000', 'test-secret', async () => Response.json(context), true), f.bridge.skillsDir);
  t.after(() => dev.close());
  await dev.bind('1');
  await seedAnalysis(f.ws, dev.stateRoot);
  const flow = await new Planning({ ...f.session, bridge: async () => dev }, {}, f.deps).initialize();
  f.ui.choose = async () => assert.fail('Do not clear a different connection through this client');
  await assert.rejects(flow.write(), error => error.code === 'generation_active' && /another SupportPages.io connection.*without --dev/.test(error.message));
  assert.deepEqual(await f.bridge.runs.read(prepared.run_id), before);
  assert.equal(f.launches.length, 0);
});

test('Claude analysis and writing default to Sonnet low without model prompts and retain saved overrides', async t => {
  const f = await planning(t, { analysed: false, options: { agent: 'claude' } });
  f.ui.choose = async () => assert.fail('Model defaults must not prompt');
  await f.flow.analyse();
  await f.flow.write();
  for (const call of [...f.tasks, ...f.launches]) {
    assert.equal(call.model, 'sonnet'); assert.equal(call.effort, 'low');
  }
  const settings = { agent: 'codex', models: { claude: { model: 'opus', effort: 'high' }, codex: { model: null, effort: null } } };
  await f.ws.writeJson('.rtfm/supportpages/setup/settings.json', settings);
  f.flow.agent = undefined;
  await f.flow.analyse(true);
  await f.flow.write();
  assert.equal(f.tasks.at(-1).model, 'opus'); assert.equal(f.tasks.at(-1).effort, 'high');
  assert.equal(f.launches.at(-1).model, 'opus'); assert.equal(f.launches.at(-1).effort, 'high');
  assert.deepEqual(await f.ws.json('.rtfm/supportpages/setup/settings.json'), { ...settings, agent: 'claude' });
});

test('an interrupted analysis keeps the connection, releases the lock, and resumes without false readiness', async t => {
  const f = await planning(t, { analysed: false });
  const run = f.deps.runAgent;
  f.deps.runAgent = async () => { await f.ws.write('.rtfm/branding.css', 'partial'); throw new Cancelled(); };
  await assert.rejects(f.flow.analyse(), Cancelled);
  assert.equal((await f.bridge.setup.analysis()).status, 'required');
  assert.equal((await f.ws.json('.rtfm/supportpages/setup/task.json')).status, 'cancelled');
  assert.equal(await f.ws.exists('.rtfm/supportpages/operation.lock'), false);
  assert.equal((await f.bridge.binding()).project_id, '1');
  f.deps.runAgent = run;
  await f.flow.analyse(); assert.equal((await f.bridge.setup.analysis()).status, 'ready');
});

test('failed refresh restores the last valid analysis and never accepts success text alone', async t => {
  const f = await planning(t);
  const before = await f.bridge.setup.analysis();
  f.deps.runAgent = async () => { await f.ws.writeJson('.rtfm/project_map.json', { framework: 'broken' }); };
  await assert.rejects(f.flow.analyse(true));
  assert.deepEqual(await f.bridge.setup.analysis(), before);
  assert.equal((await f.ws.json('.rtfm/supportpages/setup/task.json')).status, 'failed');
  assert.equal(await f.ws.exists('.rtfm/supportpages/operation.lock'), false);
});

test('complete legacy analysis is adopted, but branding-only detection runs full analysis', async t => {
  const f = await planning(t);
  await rm(path.join(f.root, '.rtfm/supportpages/setup/analysis.json'));
  await f.flow.analyse(); assert.equal(f.tasks.length, 0);
  await rm(path.join(f.root, '.rtfm/supportpages/setup/analysis.json'));
  await rm(path.join(f.root, 'output/detect-project/overview.txt'));
  await f.flow.analyse(); assert.equal(f.tasks.length, 1);
});

test('app-type correction forces a refresh and is included in the agent task', async t => {
  const f = await planning(t, { options: { 'app-type': 'desktop' } });
  await f.flow.reviewAnalysis();
  assert.equal(f.tasks.length, 1);
  assert.match(f.tasks[0].prompt, /Explicit app_type=desktop/);
});

test('checkout changes offer an optional refresh and do not invalidate usable analysis', async t => {
  const f = await planning(t);
  await f.bridge.setup.accept('output/detect-project', 'fixture', '1', 'a'.repeat(40));
  f.deps.run = async () => ({ code: 0, stdout: 'b'.repeat(40) });
  f.ui.confirm = async question => { assert.match(question, /checkout has changed/); return false; };
  await f.flow.analyse(); assert.equal(f.tasks.length, 0);
  assert.equal((await f.bridge.setup.analysis()).status, 'ready');
  f.ui.confirm = async () => true;
  await f.flow.analyse(); assert.equal(f.tasks.length, 1);
  assert.equal((await f.bridge.setup.analysis()).source_commit, 'b'.repeat(40));
});

test('headless permission failures offer interactive recovery but still require valid outputs', async t => {
  const f = await planning(t, { analysed: false, choices: ['interactive'] });
  const writeOutputs = f.deps.runAgent;
  f.deps.runAgent = async () => { throw Object.assign(Error('Permission blocked'), { code: 'agent_failed' }); };
  f.deps.openAgent = async value => { await writeOutputs(value); return true; };
  await f.flow.analyse();
  assert.equal((await f.bridge.setup.analysis()).status, 'ready');
  f.choices.push('interactive');
  f.deps.openAgent = async () => true;
  await assert.rejects(f.flow.analyse(true));
  assert.equal((await f.bridge.setup.analysis()).status, 'ready');
  assert.equal((await f.bridge.setup.progress()).status, 'failed');
});

test('analysis is explicitly confirmed before starting the selected coding agent', async t => {
  const f = await planning(t, { analysed: false });
  let approved = false;
  const run = f.deps.runAgent;
  f.ui.confirm = async question => {
    assert.equal(f.tasks.length, 0);
    assert.equal(question, 'Run the analysis now with Codex?');
    assert.match(f.lines.join('\n'), /map its screens, styles and branding/);
    assert.match(f.lines.join('\n'), /with your existing account and takes about 5 minutes/);
    approved = true; return true;
  };
  f.deps.runAgent = async value => { assert.equal(approved, true); return run(value); };
  await f.flow.analyse();
  assert.equal(f.tasks.length, 1);
  f.ui.confirm = async () => assert.fail('Reusing analysis does not start an agent or need confirmation');
  await f.flow.analyse(); assert.equal(f.tasks.length, 1);
});

test('declining analysis saves the connection and keeps writing blocked without starting a task', async t => {
  const f = await planning(t, { analysed: false });
  f.ui.confirm = async () => false;
  assert.equal(await f.flow.reviewAnalysis(), false);
  assert.equal(f.tasks.length, 0);
  assert.equal((await f.bridge.binding()).project_id, '1');
  assert.equal((await f.bridge.setup.analysis()).status, 'required');
  assert.equal(await f.ws.exists('.rtfm/supportpages/setup/task.json'), false);
  assert.equal(await f.ws.exists('.rtfm/supportpages/operation.lock'), false);
  assert.match(f.lines.join('\n'), /Analysis deferred. Your project settings are saved.\nRun supportpages analyse when you are ready/);
  await assert.rejects(f.flow.write(), { code: 'analysis_required' });
});

test('declining a refresh keeps the accepted analysis intact', async t => {
  const f = await planning(t, { options: { refresh: true } });
  const before = await f.bridge.setup.analysis();
  f.ui.confirm = async () => false;
  assert.equal(await f.flow.reviewAnalysis(), false);
  assert.equal(f.tasks.length, 0);
  assert.deepEqual(await f.bridge.setup.analysis(), before);
  assert.match(f.lines.join('\n'), /previous analysis is still ready/);
});

test('analysis readiness is reported only after output validation finishes', async t => {
  const f = await planning(t, { analysed: false });
  const events = [];
  f.ui.progress = text => { events.push(text); return { stop: (...args) => events.push(args) }; };
  await f.flow.analyse();
  assert.deepEqual(events, ['Checking analysis files…', ['Analysis files checked and saved.']]);
  events.length = 0;
  f.deps.runAgent = async () => {};
  await assert.rejects(f.flow.analyse(true));
  assert.deepEqual(events, ['Checking analysis files…', ['Analysis files could not be validated.', 'error']]);
});

test('a legacy nested-app detection can be recovered on rerun without another agent call', async t => {
  const f = await planning(t, { analysed: false });
  const writeOutputs = f.deps.runAgent;
  f.deps.runAgent = async value => {
    await writeOutputs(value);
    for (const name of ['branding.json', 'project_map.json', 'branding.css']) {
      await f.ws.write(`primary-app/.rtfm/${name}`, await f.ws.read(`.rtfm/${name}`));
      await rm(path.join(f.root, '.rtfm', name));
    }
  };
  await assert.rejects(f.flow.analyse(), error => error.code === 'invalid_analysis' && /recover a completed nested-application analysis/.test(error.message));
  assert.equal(f.tasks.length, 1);
  assert.equal((await f.bridge.setup.progress()).status, 'failed');
  f.ui.confirm = async question => { assert.equal(question, 'Reuse the completed analysis for primary-app?'); return true; };
  f.deps.runAgent = async () => assert.fail('Completed nested analysis should be recovered');
  await f.flow.analyse();
  assert.equal((await f.bridge.setup.analysis()).codebase_dir, 'primary-app');
  assert.equal((await f.bridge.setup.progress()).status, 'completed');
  assert.equal(await f.ws.exists('.rtfm/branding.json'), false);
});

test('new detection records its nested application and refresh restores that cache on failure', async t => {
  const f = await planning(t, { analysed: false });
  const writeOutputs = f.deps.runAgent;
  f.deps.runAgent = async value => {
    assert.match(value.prompt, /analysis-target.json/);
    await writeOutputs(value);
    for (const name of ['branding.json', 'project_map.json', 'branding.css']) {
      await f.ws.write(`apps/web/.rtfm/${name}`, await f.ws.read(`.rtfm/${name}`));
      await rm(path.join(f.root, '.rtfm', name));
    }
    await f.ws.writeJson(`${path.relative(f.root, value.env.RTFM_OUTPUT_DIR)}/analysis-target.json`, { codebase_dir: 'apps/web' });
  };
  await f.flow.analyse();
  const before = await f.bridge.setup.analysis();
  assert.equal(before.codebase_dir, 'apps/web');
  f.deps.runAgent = async () => { await f.ws.write('apps/web/.rtfm/branding.css', ' '); };
  await assert.rejects(f.flow.analyse(true));
  assert.deepEqual(await f.bridge.setup.analysis(), before);
});

test('remaining permission blocks are recorded before offering interactive recovery', async t => {
  const f = await planning(t, { analysed: false });
  const run = f.deps.runAgent;
  f.deps.runAgent = async value => {
    assert.match(value.prompt, /Do not work around permission denials/);
    throw Object.assign(Error('Approval needed'), { code: 'agent_permission_required' });
  };
  f.ui.choose = async question => {
    assert.equal(question, 'Continue this setup stage?');
    assert.equal((await f.bridge.setup.progress()).status, 'failed');
    return 'interactive';
  };
  f.deps.openAgent = async value => {
    assert.equal((await f.bridge.setup.progress()).status, 'running');
    await run(value); return true;
  };
  await f.flow.analyse();
  assert.equal((await f.bridge.setup.analysis()).status, 'ready');
});
