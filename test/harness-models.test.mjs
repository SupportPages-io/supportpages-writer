import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fixture } from './helpers.mjs';
import { discoverModels } from '../scripts/lib/harness-models.mjs';
import { configureAgent, configureAgents, quietModelSettings } from '../scripts/lib/agent-settings.mjs';
import { Cancelled } from '../scripts/lib/terminal.mjs';

async function harness(t, source) {
  const f = await fixture(t);
  const script = await f.ws.write('harness.cjs', `
    const fs = require('node:fs');
    const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
    require('node:readline').createInterface({input:process.stdin}).on('line', line => {
      const request = JSON.parse(line);
      fs.appendFileSync('requests.jsonl', line + '\\n');
      ${source}
    });
  `);
  let child, invocation;
  return { ...f, options: { cwd: f.root, env: { ...process.env, SUPPORTPAGES_API_TOKEN: 'private-token', SUPPORTPAGES_API_TOKEN_FILE: 'private-file' },
    spawnProcess: (command, args, options) => {
      invocation = { command, args, options };
      child = spawn(process.execPath, [script], options);
      return child;
    } },
    invocation: () => invocation, child: () => child,
    requests: async () => (await readFile(`${f.root}/requests.jsonl`, 'utf8')).trim().split('\n').map(JSON.parse) };
}

test('Codex discovery initializes, paginates and returns visible model IDs with effort metadata', async t => {
  const h = await harness(t, `
    if (request.method === 'initialize') send({id:request.id,result:{}});
    if (request.method === 'model/list') {
      send({method:'notification'});
      send({id:request.id,result:request.params.cursor ? {data:[
        {model:'new-model',displayName:'Duplicate'}, {model:'custom-provider/model',displayName:'Custom'}
      ],nextCursor:null} : {data:[
        {model:'new-model',displayName:'New model',isDefault:true,defaultReasoningEffort:'high',supportedReasoningEfforts:[{reasoningEffort:'high'}]},
        {model:'hidden-model',hidden:true}, {model:'--invalid'}, null
      ],nextCursor:'second'}});
    }
  `);
  const models = await discoverModels('codex', h.options);
  assert.deepEqual(models.map(m => m.value), ['new-model', 'custom-provider/model']);
  assert.equal(models[0].isDefault, true);
  assert.deepEqual(models[0].efforts, ['high']);
  assert.equal(models[0].defaultEffort, 'high');
  assert.deepEqual((await h.requests()).map(r => r.method), ['initialize', 'initialized', 'model/list', 'model/list']);
  const invocation = h.invocation();
  assert.deepEqual(invocation.args, ['app-server']);
  assert.equal(invocation.options.cwd, h.root);
  assert.equal(invocation.options.env.SUPPORTPAGES_API_TOKEN, undefined);
  assert.equal(invocation.options.env.SUPPORTPAGES_API_TOKEN_FILE, undefined);
  assert.notEqual(h.child().signalCode, null);
});

test('Claude discovery only sends initialization, disables tools/hooks/MCP and uses harness aliases', async t => {
  const h = await harness(t, `send({type:'control_response',response:{subtype:'success',request_id:request.request_id,response:{models:[
    {value:'default',displayName:'Default',resolvedModel:'resolved-version',supportsEffort:true,supportedEffortLevels:['low','high']},
    {value:'new-claude[1m]',displayName:'New Claude',supportsEffort:false}
  ]}}});`);
  const models = await discoverModels('claude', h.options);
  assert.deepEqual(models.map(m => m.value), ['default', 'new-claude[1m]']);
  assert.deepEqual(models[1].efforts, []);
  assert.equal(models[0].isDefault, true);
  assert.deepEqual(await h.requests(), [{ type: 'control_request', request_id: 'models', request: { subtype: 'initialize' } }]);
  assert.ok(h.invocation().args.includes('--no-session-persistence'));
  assert.ok(h.invocation().args.includes('--strict-mcp-config'));
  assert.ok(h.invocation().args.includes('{"disableAllHooks":true}'));
  assert.equal(h.invocation().args[h.invocation().args.indexOf('--tools') + 1], '');
});

test('discovery rejects malformed, empty, failed and unbounded responses without exposing diagnostics', async t => {
  for (const source of [
    `process.stdout.write('private malformed response\\n');`,
    `send({id:request.id,error:{message:'private credential'}});`,
    `send({id:request.id,result:{data:[],nextCursor:null}});`,
    `send({id:request.id,result:{data:[],nextCursor:'loop'}});`,
    `process.stdout.write('x'.repeat(3*1024*1024));`,
    `process.exit(1);`,
  ]) {
    const h = await harness(t, source);
    await assert.rejects(discoverModels('codex', h.options), { message: 'The coding agent could not list its models.' });
  }
});

test('discovery bounds hangs, handles missing executables, and cleans up on cancellation', async t => {
  const h = await harness(t, '');
  await assert.rejects(discoverModels('claude', { ...h.options, timeoutMs: 100 }), /could not list/);
  assert.notEqual(h.child().signalCode, null);
  await assert.rejects(discoverModels('codex', { cwd: h.root, spawnProcess: (_cmd, args, options) => spawn('/missing-supportpages-test-harness', args, options) }), /could not list/);
  const before = process.listenerCount('SIGINT');
  const pending = discoverModels('claude', h.options);
  process.emit('SIGINT');
  await assert.rejects(pending, Cancelled);
  assert.equal(process.listenerCount('SIGINT'), before);
  assert.notEqual(h.child().signalCode, null);
});

async function picker(t, saved = {}) {
  const f = await fixture(t);
  const file = '.rtfm/supportpages/setup/settings.json';
  await f.ws.writeJson(file, saved);
  const logs = [], prompts = [];
  const session = { options: {}, bridge: async () => f.bridge };
  const deps = { env: {}, run: async command => ({ code: command === 'codex' ? 0 : 1 }),
    discoverModels: async (agent, options) => {
      assert.equal(agent, 'codex'); assert.equal(options.cwd, f.root);
      return [{ value: 'from-harness', label: 'From harness', isDefault: true, efforts: ['medium', 'high'], defaultEffort: 'high' }];
    }, ui: { line: value => logs.push(value), ok: value => logs.push(value),
      choose: async (question, choices, index) => { prompts.push({ question, choices, index }); return choices[index].value; } } };
  return { ...f, file, logs, prompts, session, deps };
}

test('project picker saves a discovered model and its supported effort, preserving other settings', async t => {
  const h = await picker(t, { models: { claude: { model: 'custom-claude', effort: 'high' } }, unrelated: true });
  assert.deepEqual(await configureAgent(h.session, h.deps), { agent: 'codex', model: 'from-harness', effort: 'high' });
  // Only one coding agent is installed here, so the agent picker is skipped.
  assert.deepEqual(h.prompts.map(p => p.question), ['Codex model', 'Reasoning effort']);
  assert.deepEqual(h.prompts[1].choices.map(c => c.value), ['medium', 'high', 'inherit']);
  assert.deepEqual(await h.ws.json(h.file), { agent: 'codex', unrelated: true, models: {
    claude: { model: 'custom-claude', effort: 'high' }, codex: { model: 'from-harness', effort: 'high' },
  } });
});

test('saved models absent from discovery remain selectable and errors offer inheritance or manual entry', async t => {
  for (const offline of [false, true]) {
    const h = await picker(t, { agent: 'codex', models: { codex: { model: 'saved-model', effort: 'medium' } } });
    if (offline) h.deps.discoverModels = async () => { throw Error('private diagnostic'); };
    assert.deepEqual(await configureAgent(h.session, h.deps), { agent: 'codex', model: 'saved-model', effort: 'medium' });
    const prompt = h.prompts[0];
    assert.equal(prompt.choices[prompt.index].value, 'saved-model');
    assert.ok(prompt.choices.some(c => c.value === 'inherit'));
    assert.ok(prompt.choices.some(c => c.value === 'custom'));
    assert.doesNotMatch(h.logs.join('\n'), /private diagnostic/);
  }
  const h = await picker(t);
  h.deps.discoverModels = async () => { throw Error('offline'); };
  assert.deepEqual(await configureAgent(h.session, h.deps), { agent: 'codex', model: null, effort: null });
  assert.deepEqual(h.prompts[0].choices.map(c => c.value), ['inherit', 'custom']);
});

test('cancelling model discovery or effort selection leaves all project settings intact', async t => {
  for (const discovery of [true, false]) {
    const saved = { agent: 'claude', models: { claude: { model: 'saved-claude', effort: 'low' } } };
    const h = await picker(t, saved);
    if (discovery) h.deps.discoverModels = async () => { throw new Cancelled(); };
    else h.deps.ui.choose = async (question, choices) => { if (question === 'Coding agent for this project') return 'codex'; if (choices.some(c => c.value === 'high')) throw new Cancelled(); return 'from-harness'; };
    await assert.rejects(configureAgent(h.session, h.deps), Cancelled);
    assert.deepEqual(await h.ws.json(h.file), saved);
  }
});

test('repeat selection preserves explicit effort inheritance despite a harness default', async t => {
  const h = await picker(t, { agent: 'codex', models: { codex: { model: 'from-harness', effort: null } } });
  assert.deepEqual(await configureAgent(h.session, h.deps), { agent: 'codex', model: 'from-harness', effort: null });
});

test('first init saves the strongest available models at Medium instead of provider defaults', async t => {
  const h = await picker(t);
  h.deps.run = async () => ({ code: 0 });
  const catalogues = {
    claude: [
      { value: 'default', label: 'Default', isDefault: true, hint: 'Opus is the current default' },
      { value: 'opus[1m]', label: 'Opus (1M context)', efforts: ['low', 'medium', 'high'] },
      { value: 'claude-fable-5-1[1m]', label: 'Fable', efforts: ['low', 'medium', 'high'] },
      { value: 'sonnet', label: 'Sonnet' },
    ],
    codex: [
      { value: 'gpt-6-astra', label: 'Astra', isDefault: true, hint: 'Provider description', efforts: ['low', 'medium', 'high'], defaultEffort: 'low' },
      { value: 'gpt-5.6-sol', label: 'Sol', efforts: ['low', 'medium', 'high'], defaultEffort: 'low' },
    ],
  };
  const original = structuredClone(catalogues);
  h.deps.discoverModels = async agent => catalogues[agent];
  const result = await configureAgents(h.session, h.deps, { clients: ['claude', 'codex'] });
  assert.deepEqual(result.models, {
    claude: { model: 'opus[1m]', effort: 'medium' }, codex: { model: 'gpt-5.6-sol', effort: 'medium' },
  });
  assert.deepEqual((await h.ws.json(h.file)).models, result.models);
  assert.deepEqual(catalogues, original, 'presentation never mutates the discovered catalogue');
  const codexChoices = h.prompts.find(p => p.question === 'Codex model').choices;
  assert.equal(codexChoices.find(m => m.value === 'gpt-6-astra').hint, 'Provider description', 'a provider default that is not recommended keeps its own description');
});

test('recommendations preserve existing explicit choices and inheritance on repeat init', async t => {
  for (const settings of [
    { model: 'gpt-5.6-luna', effort: 'low' },
    { model: 'gpt-5.6-sol', effort: 'high' },
    { model: 'gpt-5.6-sol', effort: null },
    { model: null, effort: null },
  ]) {
    const h = await picker(t, { models: { codex: settings } });
    h.deps.discoverModels = async () => [
      { value: 'gpt-6-astra', label: 'Astra', efforts: ['low', 'medium', 'high'] },
      { value: 'gpt-5.6-sol', label: 'Sol', efforts: ['low', 'medium', 'high'] },
      { value: 'gpt-5.6-luna', label: 'Luna', efforts: ['low', 'medium', 'high'] },
    ];
    assert.deepEqual((await configureAgents(h.session, h.deps, { clients: ['codex'] })).models.codex, settings);
  }
});

test('Claude recommendation accepts explicit aliases and versioned IDs but not similarly named modes', async t => {
  for (const value of ['opus', 'opus[1m]', 'claude-opus-4-6', 'claude-opus-4-6[1m]']) {
    const h = await picker(t);
    h.deps.run = async () => ({ code: 0 });
    h.deps.discoverModels = async () => [
      { value: 'opusplan', label: 'Opus planning mode', isDefault: true },
      { value, label: 'Opus', efforts: ['low', 'medium', 'high'] },
    ];
    assert.deepEqual((await configureAgents(h.session, h.deps, { clients: ['claude'] })).models.claude, { model: value, effort: 'medium' });
  }
});

test('a recommended model without Medium uses only its supported effort choices', async t => {
  for (const supported of [[], ['high']]) {
    const h = await picker(t);
    h.deps.discoverModels = async () => [{ value: 'gpt-5.6-sol', label: 'Sol', efforts: supported, defaultEffort: supported[0] }];
    const result = await configureAgents(h.session, h.deps, { clients: ['codex'] });
    assert.equal(result.models.codex.model, 'gpt-5.6-sol');
    assert.equal(result.models.codex.effort, supported[0] ?? null);
    const prompt = h.prompts.find(p => p.question === 'Reasoning effort');
    assert.deepEqual(prompt.choices.map(c => c.value), [...supported, 'inherit']);
  }
});

test('recommendations use the strongest known available fallback and newest version regardless of catalogue order', async t => {
  for (const reverse of [false, true]) {
    const h = await picker(t);
    h.deps.run = async () => ({ code: 0 });
    h.deps.discoverModels = async agent => {
      const models = agent === 'claude' ? [
        { value: 'default', label: 'Default Fable', isDefault: true },
        { value: 'claude-opus-4-5', label: 'Opus 4.5' },
        { value: 'claude-opus-4-6', label: 'Opus 4.6' },
      ] : [
        { value: 'gpt-5.6-luna', label: 'Luna', isDefault: true },
        { value: 'gpt-5.6-sol', label: 'Sol' },
      ];
      return reverse ? models.reverse() : models;
    };
    const result = await configureAgents(h.session, h.deps, { clients: ['claude', 'codex'] });
    assert.deepEqual(result.models, {
      claude: { model: 'claude-opus-4-6', effort: 'medium' },
      codex: { model: 'gpt-5.6-sol', effort: 'medium' },
    });
    for (const [question, id] of [['Claude Code model', 'claude-opus-4-6'], ['Codex model', 'gpt-5.6-sol']]) {
      const { choices } = h.prompts.find(p => p.question === question);
      assert.deepEqual(choices.filter(c => c.label.includes('Recommended for SupportPages.io')).map(c => c.value), [id]);
    }
  }
});

test('the defaults are Opus and Sol, newest first, as the coding agents list them today', () => {
  // Catalogues as Claude Code and Codex report them (September 2026).
  const claude = [
    { value: 'default', label: 'Default (recommended)', isDefault: true, efforts: ['low', 'medium', 'high'] },
    { value: 'opus', label: 'Opus 5.5', efforts: ['low', 'medium', 'high'] },
    { value: 'claude-fable-5-1', label: 'Fable 5.1', efforts: ['low', 'medium', 'high'] },
    { value: 'claude-opus-5', label: 'Opus 5', efforts: ['low', 'medium', 'high'] },
    { value: 'opus[1m]', label: 'Opus (1M context)', efforts: ['low', 'medium', 'high'] },
  ];
  const codex = [
    { value: 'gpt-6-astra', label: 'GPT-6-Astra', isDefault: true, efforts: ['low', 'medium', 'high'] },
    { value: 'gpt-6-sol', label: 'GPT-6-Sol', efforts: ['low', 'medium', 'high'] },
    { value: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', efforts: ['low', 'medium', 'high'] },
  ];
  assert.deepEqual(quietModelSettings('claude', claude), { model: 'opus', effort: 'medium' });
  assert.deepEqual(quietModelSettings('codex', codex), { model: 'gpt-6-sol', effort: 'medium' });
});
