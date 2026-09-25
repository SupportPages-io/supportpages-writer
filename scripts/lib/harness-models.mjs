import { spawn } from 'node:child_process';
import { modelValid, efforts } from '../../dist/agent-settings.js';
import { Cancelled } from './terminal.mjs';

const clean = value => typeof value === 'string' ? value.replace(/[\p{Cc}\p{Cf}]/gu, '').slice(0, 300) : '';

/** Query the installed harness's catalogue without sending a prompt or starting a turn.
 * Codex: app-server model/list. Claude: Agent SDK initialize control response.
 */
export async function discoverModels(agent, { cwd, env = process.env, spawnProcess = spawn, timeoutMs = 15000 } = {}) {
  if (!['claude', 'codex'].includes(agent)) throw Error('Unsupported coding agent.');
  const childEnv = { ...env };
  delete childEnv.SUPPORTPAGES_API_TOKEN;
  delete childEnv.SUPPORTPAGES_API_TOKEN_FILE;
  const args = agent === 'codex' ? ['app-server'] : [
    '--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--no-session-persistence', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--tools', '', '--settings', '{"disableAllHooks":true}',
  ];
  const child = spawnProcess(agent, args, { cwd, env: childEnv, stdio: ['pipe', 'pipe', 'ignore'] });
  let buffer = '', bytes = 0, requestId = 1, done = false;
  const entries = [], cursors = new Set();
  const failure = () => Error('The coding agent could not list its models.');
  let timer, interrupt;
  try {
    return await new Promise((resolve, reject) => {
      const finish = (error, value) => {
        if (done) return;
        done = true;
        error ? reject(error) : resolve(value);
      };
      const send = value => child.stdin.write(JSON.stringify(value) + '\n');
      const list = cursor => send({ id: ++requestId, method: 'model/list', params: { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) } });
      const complete = () => {
        const models = new Map();
        for (const entry of entries) {
          if (!entry || entry.hidden === true) continue;
          const value = agent === 'codex' ? entry.model : entry.value;
          if (!modelValid(value) || ['inherit', 'custom'].includes(value) || models.has(value)) continue;
          const supported = agent === 'codex' ? entry.supportedReasoningEfforts?.map?.(item => item?.reasoningEffort)
            : entry.supportedEffortLevels ?? (entry.supportsEffort === false ? [] : undefined);
          models.set(value, { value, label: clean(entry.displayName) || value, hint: clean(entry.description),
            isDefault: entry.isDefault === true || (agent === 'claude' && value === 'default'),
            ...(Array.isArray(supported) ? { efforts: [...new Set(supported.filter(effort => efforts[agent].includes(effort)))] } : {}),
            defaultEffort: entry.defaultReasoningEffort });
        }
        if (!models.size) finish(failure());
        else finish(null, [...models.values()]);
      };
      const receive = value => {
        if (!value || typeof value !== 'object') { finish(failure()); return; }
        if (agent === 'claude') {
          if (value.type !== 'control_response' || value.response?.request_id !== 'models') return;
          if (value.response.subtype !== 'success' || !Array.isArray(value.response.response?.models)) { finish(failure()); return; }
          entries.push(...value.response.response.models);
          complete();
        } else {
          if (value.id !== requestId) return;
          if (value.error) { finish(failure()); return; }
          if (requestId === 1) {
            send({ method: 'initialized', params: {} });
            list();
          } else {
            if (!Array.isArray(value.result?.data)) { finish(failure()); return; }
            entries.push(...value.result.data);
            const cursor = value.result.nextCursor;
            if (cursor == null) complete();
            else if (typeof cursor !== 'string' || !cursor || cursors.has(cursor) || cursors.size >= 10) finish(failure());
            else { cursors.add(cursor); list(cursor); }
          }
        }
      };
      interrupt = () => finish(new Cancelled());
      process.once('SIGINT', interrupt);
      process.once('SIGTERM', interrupt);
      timer = setTimeout(() => finish(failure()), timeoutMs);
      child.on('error', () => finish(failure()));
      child.on('close', () => finish(failure()));
      child.stdin.on('error', () => finish(failure()));
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        if (done) return;
        bytes += Buffer.byteLength(chunk);
        if (bytes > 2 * 1024 * 1024) { finish(failure()); return; }
        buffer += chunk;
        let newline;
        while (!done && (newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          try { receive(JSON.parse(line)); } catch { finish(failure()); }
        }
      });
      send(agent === 'codex'
        ? { id: 1, method: 'initialize', params: { clientInfo: { name: 'supportpages', version: '0.1.0' }, capabilities: {} } }
        : { type: 'control_request', request_id: 'models', request: { subtype: 'initialize' } });
    });
  } finally {
    clearTimeout(timer);
    if (interrupt) { process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); }
    child.stdin.end();
    child.kill('SIGTERM');
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise(resolve => {
        const killTimer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 1000);
        child.once('exit', () => { clearTimeout(killTimer); resolve(); });
      });
    }
  }
}
