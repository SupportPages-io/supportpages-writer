import path from 'node:path';
import os from 'node:os';
import { lstat, realpath } from 'node:fs/promises';
import { installManagedWriter } from './managed-writer.mjs';
import { withCodexConfig } from './codex-config.mjs';
import { installCodexSkill } from './codex-skill.mjs';
import { askFirstTools } from './claude-permissions.mjs';

export async function installCodexIntegration({ home = os.homedir(), env = process.env, name, configDir, backup, ui, codexConfig = withCodexConfig, registration, announcePermission = true }) {
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(name)) throw Error('Invalid SupportPages.io connection name.');
  const config = path.resolve(env.CODEX_HOME || path.join(home, '.codex'));
  const { codexWriterFile, writerAgentType } = await import('../../dist/writer-agent.js');
  const agent = await installManagedWriter({ config, name: writerAgentType, extension: 'toml', contents: codexWriterFile, marker: '# Managed by SupportPages: article writer v1' });
  if (agent.changed) ui?.line('Installed the SupportPages Writer agent for Codex. Restart existing Codex sessions to load it.');
  const skill = await installCodexSkill({ home, env });
  if (skill.changed) ui?.line('Installed the SupportPages.io article skill for Codex. Restart existing Codex sessions to load it.');
  const filename = path.join(config, 'config.toml');
  const info = await lstat(filename);
  if (info.isSymbolicLink() || !info.isFile()) throw Error(`Cannot update Codex permissions at an unsafe path: ${filename}`);
  const canonical = await realpath(filename);
  const permission = await codexConfig({ env: { ...env, CODEX_HOME: config }, cwd: config }, async request => {
    const state = await request('config/read', { includeLayers: true });
    const user = state.layers?.find(layer => layer.name?.type === 'user' && !layer.name.profile && path.resolve(layer.name.file) === canonical);
    if (!user?.version) throw Error('Codex did not return a version for its user settings. Update Codex and rerun supportpages init.');
    const server = state.config?.mcp_servers?.[name];
    if (!server) throw Error('Register the SupportPages.io Codex connection before installing its publishing permission.');
    const edits = [];
    if (registration) {
      if (!server.command || server.url) throw Error('The existing Codex connection is not the expected local SupportPages.io server. Keep it and choose another connection name.');
      edits.push({ keyPath: `mcp_servers.${name}.command`, value: registration.command, mergeStrategy: 'replace' },
        { keyPath: `mcp_servers.${name}.args`, value: registration.args, mergeStrategy: 'replace' });
    }
    const mode = server.tools?.supportpages_publish_article?.approval_mode;
    let keptExistingPolicy = false;
    if (mode !== 'approve' && (mode || server.enabled === false || server.disabled_tools?.includes('supportpages_publish_article') ||
        server.enabled_tools && !server.enabled_tools.includes('supportpages_publish_article') ||
        ['prompt', 'writes'].includes(server.default_tools_approval_mode))) {
      ui?.line('Kept your existing Codex publishing restrictions. Manage them in Codex permission settings.');
      keptExistingPolicy = true;
    }
    // Pre-approve the server's tools (publish explicitly) unless the user restricted
    // them; removing content always asks unless the user already chose otherwise.
    const tool = (id, value) => ({ keyPath: `mcp_servers.${name}.tools.${id}.approval_mode`, value, mergeStrategy: 'upsert' });
    const policies = keptExistingPolicy ? [] : [
      ...(mode !== 'approve' ? [tool('supportpages_publish_article', 'approve')] : []),
      ...(server.default_tools_approval_mode === undefined
        ? [{ keyPath: `mcp_servers.${name}.default_tools_approval_mode`, value: 'approve', mergeStrategy: 'upsert' }] : []),
    ];
    for (const id of askFirstTools) if (server.tools?.[id]?.approval_mode === undefined) policies.push(tool(id, 'prompt'));
    const changed = policies.length > 0;
    edits.push(...policies);
    if (!edits.length) return { changed, ...(keptExistingPolicy ? { keptExistingPolicy } : {}) };
    await backup(filename, path.join(configDir, 'backups'));
    const result = await request('config/batchWrite', { filePath: canonical, expectedVersion: user.version, edits });
    if (result.status !== 'ok') throw Error('Codex could not save the SupportPages.io tool permissions.');
    if (changed && announcePermission) ui?.line("Allowed SupportPages Writer's tools in Codex; deleting or unpublishing an article still asks first.");
    return { changed, ...(keptExistingPolicy ? { keptExistingPolicy } : {}) };
  });
  return { agent, skill, permission };
}
