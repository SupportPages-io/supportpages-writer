import { fail } from './errors.js';
import { Workspace } from './workspace.js';
import { z } from 'zod';

type SettingsWorkspace = { ws: Workspace; stateRoot: string };

export const efforts: Record<string, string[]> = { claude: ['low', 'medium', 'high', 'xhigh', 'max'], codex: ['minimal', 'low', 'medium', 'high', 'xhigh'] };
export const modelValid = (value: unknown): value is string => typeof value === 'string' && value.length <= 200 && /^[a-zA-Z0-9][a-zA-Z0-9._:/\[\]-]*$/.test(value);
export const settingsFile = (bridge: SettingsWorkspace) => `${bridge.stateRoot}/setup/settings.json`;

// Undefined means SupportPages.io defaults; null explicitly inherits the agent setting.
export function modelSettings(agent: string, saved: unknown = {}) {
  if (!efforts[agent]) fail('invalid_agent', 'Choose Claude Code or Codex.');
  const values = z.object({ model: z.unknown().optional(), effort: z.unknown().optional() }).safeParse(saved);
  if (!values.success) fail('invalid_configuration', 'Invalid coding-agent settings. Run supportpages configure to change them.');
  const model = values.data.model === undefined ? (agent === 'claude' ? 'sonnet' : null) : values.data.model;
  const effort = values.data.effort === undefined ? (agent === 'claude' ? 'low' : null) : values.data.effort;
  if (model !== null && !modelValid(model) || effort !== null && (typeof effort !== 'string' || !efforts[agent]!.includes(effort))) {
    fail('invalid_configuration', 'Invalid coding-agent model or effort. Run supportpages configure to change it.');
  }
  return { model, effort };
}

export async function readAgentSettings(bridge: SettingsWorkspace) {
  const value = await bridge.ws.exists(settingsFile(bridge)) ? await bridge.ws.json(settingsFile(bridge)) : {};
  const result = z.object({
    models: z.record(z.string(), z.unknown()).optional(),
    agents: z.array(z.enum(['claude', 'codex'])).min(1).max(2).refine(agents => new Set(agents).size === agents.length).optional(),
  }).passthrough().safeParse(value);
  if (!result.success) {
    fail('invalid_configuration', 'The saved coding-agent settings are invalid.');
  }
  return result.data;
}

export async function executionSettings(bridge: SettingsWorkspace, agent: string) {
  return modelSettings(agent, (await readAgentSettings(bridge)).models?.[agent] ?? {});
}
