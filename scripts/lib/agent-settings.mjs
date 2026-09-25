import { fail } from '../../dist/errors.js';
import { discoverModels } from './harness-models.mjs';
import { Cancelled } from './terminal.mjs';

export const agentLabel = agent => agent === 'claude' ? 'Claude Code' : 'Codex';
import { efforts, modelValid, settingsFile, modelSettings, readAgentSettings } from '../../dist/agent-settings.js';
export { modelSettings, readAgentSettings, executionSettings } from '../../dist/agent-settings.js';

// Preferred families for articles, best first: Opus then Fable on Claude Code, Sol
// then Astra on Codex (today Opus 5.5 and GPT-6-Sol). Catalogue order and isDefault
// are not rankings. Only recommend IDs actually exposed by the coding agent.
function recommendedModel(agent, models) {
  const families = agent === 'claude' ? ['opus', 'fable'] : ['sol', 'astra'];
  for (const family of families) {
    const pattern = agent === 'claude'
      ? new RegExp(`^(?:${family}|claude-${family}-\\d+(?:[.-]\\d+)*)(?:\\[[^\\]]+\\])?$`)
      : new RegExp(`^gpt-\\d+(?:\\.\\d+)?-${family}$`);
    const matches = models.filter(({ value }) => pattern.test(value));
    if (!matches.length) continue;
    // Claude's explicit family alias follows its current release. Otherwise
    // choose the newest version within the family, independently of list order.
    return matches.find(model => model.value === family)
      ?? matches.find(model => model.value === `${family}[1m]`)
      ?? matches.sort((a, b) => b.value.localeCompare(a.value, 'en', { numeric: true }))[0];
  }
}

function modelHint(agent, model, recommended) {
  if (model.value === recommended?.value) return 'Recommended for faithful mockups and detailed articles. Use Medium effort when available.';
  const lighter = agent === 'claude'
    ? /^(?:(?:sonnet|haiku)|claude-(?:sonnet|haiku)-\d+(?:[.-]\d+)*)(?:\[[^\]]+\])?$/.test(model.value)
    : /^gpt-\d+(?:\.\d+)?-(?:terra|luna)$/.test(model.value);
  return lighter ? 'Suitable for rough drafts and simpler mockups. Expect more review and visual corrections.' : model.hint;
}

const effortHints = {
  minimal: 'For quick drafts where approximate mockups are acceptable.',
  low: 'For quick drafts where approximate mockups are acceptable.',
  medium: 'Our recommended starting point for faithful mockups and article quality.',
  high: 'Allow more reasoning for complex interfaces. Generation can take longer.',
  xhigh: 'Allow more reasoning for complex interfaces. Generation can take longer.',
  max: 'Allow more reasoning for complex interfaces. Generation can take longer.',
};

export function modelDescription(agent, settings) {
  const { model, effort } = modelSettings(agent, settings);
  return `${agentLabel(agent)} · ${model ?? 'agent-configured model'} · ${effort ? `${effort} effort` : 'agent-configured effort'}`;
}

export async function availableAgents(session, deps, clients = []) {
  const available = [];
  for (const agent of ['claude', 'codex']) {
    if (clients.length && !clients.includes(agent)) continue;
    if ((await deps.run(agent, ['--version'], { capture: true })).code !== 0) continue;
    if (!clients.length && (await deps.run(agent, ['mcp', 'get', session.options.dev ? 'supportpages-dev' : 'supportpages'], { capture: true })).code !== 0) continue;
    available.push(agent);
  }
  if (!available.length) fail('agent_unavailable', 'No coding agent is connected yet. Install Claude Code or Codex, then run supportpages setup to connect it.');
  return available;
}

/**
 * With both agents connected, ask which runs project analysis. Claude Code is listed
 * first and preselected unless this project already chose; writing always uses
 * whichever agent the user is working in.
 */
async function chooseAnalysisAgent(ui, clients, preferred) {
  if (clients.length < 2) return clients[0];
  const ordered = [...clients].sort((a, b) => (b === 'claude') - (a === 'claude'));
  const initial = clients.includes(preferred) ? preferred : ordered[0];
  ui.line('Project analysis runs in one agent and becomes the default for supportpages analyse. When you write, SupportPages uses whichever agent you are working in.');
  return ui.choose('Which coding agent should run project analysis?', ordered.map(value => ({ value, label: agentLabel(value),
    ...(value === 'claude' ? { hint: 'Recommended' } : {}) })), ordered.indexOf(initial));
}

export async function configureAgent(session, deps, { clients = [], agent: requestedAgent } = {}) {
  const bridge = await session.bridge(), saved = await readAgentSettings(bridge);
  const available = await availableAgents(session, deps, clients);
  const { ui } = deps;
  if (requestedAgent && !available.includes(requestedAgent)) fail('agent_unavailable', 'The selected coding agent is not connected. Run supportpages setup to connect it.');
  const preferred = requestedAgent ?? saved.agent;
  const agent = available.length === 1
    ? available[0]
    : await ui.choose('Coding agent for this project', available.map(value => ({ value, label: agentLabel(value) })), Math.max(0, available.indexOf(preferred)));
  const settings = await chooseModelSettings(agent, saved, bridge, deps);
  // Commit only after all prompts succeed; keep settings for the other agent.
  await bridge.ws.writeJson(settingsFile(bridge), { ...saved,
    ...(saved.agents ? { agents: [...new Set([...saved.agents, agent])] } : {}),
    agent, models: { ...saved.models, [agent]: settings } });
  ui.ok(`Saved for this project: ${modelDescription(agent, settings)}.`);
  return { agent, ...settings };
}

/** Init configures every selected integration before committing project choices. */
export async function configureAgents(session, deps, { clients, agent: requestedAgent } = {}) {
  const bridge = await session.bridge(), saved = await readAgentSettings(bridge);
  const available = await availableAgents(session, deps, clients);
  if (available.length !== clients.length) fail('agent_unavailable', 'A selected coding agent is no longer available. Run supportpages init again.');
  const models = { ...saved.models };
  for (const agent of clients) {
    deps.ui.line(`Configure ${agentLabel(agent)} for this project.`);
    models[agent] = await chooseModelSettings(agent, saved, bridge, deps);
  }
  const agent = await chooseAnalysisAgent(deps.ui, clients, requestedAgent ?? saved.agent);
  await bridge.ws.writeJson(settingsFile(bridge), { ...saved, agents: clients, agent, models });
  for (const client of clients) deps.ui.ok(`Saved for this project: ${modelDescription(client, models[client])}.`);
  return { agent, models };
}

/** The recommended model with Medium effort when the catalogue supports it, without prompting. */
export function quietModelSettings(agent, discovered) {
  const recommended = recommendedModel(agent, discovered);
  const model = recommended?.value ?? discovered.find(entry => entry.isDefault)?.value ?? null;
  const metadata = discovered.find(entry => entry.value === model);
  const effort = (metadata?.efforts ?? efforts[agent]).includes('medium') ? 'medium' : null;
  return modelSettings(agent, { model, effort });
}

/** How init names a model: the agent's own label when it lists the model. */
function describeModel(agent, settings, discovered) {
  const model = settings.model === null ? `${agentLabel(agent)}’s default model`
    : discovered.find(entry => entry.value === settings.model)?.label ?? settings.model;
  const effort = settings.effort ? `${settings.effort[0].toUpperCase()}${settings.effort.slice(1)} effort` : 'its default effort';
  return `${model} at ${effort}`;
}

/**
 * Init: state each agent's model for this project (the saved choice, or the
 * recommended one) and ask whether to change it. Nothing is saved until every
 * question is answered.
 */
export async function confirmAgentModels(session, deps, { clients, agent: requestedAgent } = {}) {
  const bridge = await session.bridge(), saved = await readAgentSettings(bridge);
  const available = await availableAgents(session, deps, clients);
  if (available.length !== clients.length) fail('agent_unavailable', 'A selected coding agent is no longer available. Run supportpages setup to repair it.');
  const { ui } = deps;
  const models = { ...saved.models };
  for (const agent of clients) {
    ui.info?.(`Getting available models from ${agentLabel(agent)}…`);
    let discovered = [];
    try { discovered = await (deps.discoverModels ?? discoverModels)(agent, { cwd: bridge.ws.root, env: deps.env }); }
    catch (error) { if (error instanceof Cancelled) throw error; }
    let current;
    try { current = saved.models?.[agent] ? modelSettings(agent, saved.models[agent]) : undefined; }
    catch { current = undefined; }
    current ??= quietModelSettings(agent, discovered);
    if (!discovered.length && !saved.models?.[agent]) ui.line(`Could not get the model list from ${agentLabel(agent)}, so it will use its own default model. Check its sign-in and version to choose one.`);
    ui.line(`${agentLabel(agent)} will write this project’s articles with ${describeModel(agent, current, discovered)}.`);
    models[agent] = await ui.confirm(`Change the ${agentLabel(agent)} model?`, false)
      ? await chooseModelSettings(agent, saved, bridge, deps, discovered)
      : current;
  }
  // The analysis step asks which agent runs it; until then keep the project's choice,
  // or default to Claude Code.
  const preferred = requestedAgent ?? saved.agent;
  const agent = clients.includes(preferred) ? preferred : clients.includes('claude') ? 'claude' : clients[0];
  await bridge.ws.writeJson(settingsFile(bridge), { ...saved, agents: clients, agent, models });
  return { agent, models };
}

async function chooseModelSettings(agent, saved, bridge, deps, listed) {
  const { ui } = deps;
  // Allow configure to repair an obsolete model or effort selection.
  let current;
  try { current = modelSettings(agent, saved.models?.[agent] ?? {}); }
  catch { current = modelSettings(agent); }
  let discovered = listed ?? [];
  // Init passes the catalogue it has just listed; an empty one is retried here.
  if (!discovered.length) try {
    ui.info?.(`Getting available models from ${agentLabel(agent)}…`);
    discovered = await (deps.discoverModels ?? discoverModels)(agent, { cwd: bridge.ws.root, env: deps.env });
  } catch (error) {
    if (error instanceof Cancelled) throw error;
    ui.line(`Could not get models from ${agentLabel(agent)}. You can keep your saved model, use the agent-configured model, or enter a model name. Check your coding agent's sign-in and version, then retry with supportpages configure.`);
  }
  const recommended = recommendedModel(agent, discovered);
  const models = [
    ...discovered.map(model => ({ ...model,
      label: model.value === recommended?.value ? `${model.label} — Recommended for SupportPages.io` : model.label,
      hint: modelHint(agent, model, recommended) })),
    ...(saved.models?.[agent]?.model && current.model && !discovered.some(m => m.value === current.model)
      ? [{ value: current.model, label: `${current.model} (current setting)`, hint: 'Not listed by the coding agent' }] : []),
    { value: 'inherit', label: 'Use my coding agent’s default model', hint: 'Mockup fidelity will depend on your coding agent’s model choice.' },
    { value: 'custom', label: 'Enter a model name', hint: 'For a model you already know you want to use' },
  ];
  const selected = saved.models?.[agent]?.model !== undefined
    ? current.model === null ? 'inherit' : models.some(m => m.value === current.model) ? current.model : 'custom'
    : recommended?.value ?? discovered.find(m => m.isDefault)?.value ?? 'inherit';
  ui.line('Your model analyses the application and creates the article’s illustrated mockups. Lighter models may simplify layouts or miss interface details.');
  if (recommended) ui.line(`For faithful mockups, SupportPages.io recommends ${recommended.label} with Medium effort when supported.`);
  else if (discovered.length) ui.line('We could not identify a recommended model in this catalogue. Choose an available model or use your agent’s default.');
  const choice = await ui.choose(`${agentLabel(agent)} model`, models, models.findIndex(m => m.value === selected));
  const model = choice === 'inherit' ? null : choice === 'custom'
    ? (await ui.ask('Model name', current.model ?? '', { validate: value => modelValid(value.trim()) ? undefined : 'Enter a model name, without spaces or flags.' })).trim()
    : choice;
  const metadata = discovered.find(item => item.value === model);
  const effortOptions = [
    ...(metadata?.efforts ?? efforts[agent]).map(value => ({ value,
      label: `${value[0].toUpperCase()}${value.slice(1)}${value === 'medium' ? ' — Recommended for SupportPages.io' : ''}`,
      hint: effortHints[value] })),
    { value: 'inherit', label: 'Use my coding agent’s default effort' },
  ];
  const preferredEffort = saved.models?.[agent]?.effort === null ? 'inherit'
    : saved.models?.[agent]?.effort === undefined && model === recommended?.value
      ? effortOptions.some(e => e.value === 'medium') ? 'medium' : metadata?.defaultEffort ?? 'inherit'
    : effortOptions.some(e => e.value === current.effort) ? current.effort
    : metadata?.defaultEffort ?? 'inherit';
  ui.line(effortOptions.some(e => e.value === 'medium')
    ? 'Reasoning effort controls how much time the model spends thinking. We recommend Medium for mockups; higher settings can take longer.'
    : 'This model does not list Medium effort. Choose a supported effort or use your coding agent’s default.');
  const effortChoice = await ui.choose('Reasoning effort', effortOptions, Math.max(0, effortOptions.findIndex(e => e.value === preferredEffort)));
  const settings = modelSettings(agent, { model, effort: effortChoice === 'inherit' ? null : effortChoice });
  return settings;
}
