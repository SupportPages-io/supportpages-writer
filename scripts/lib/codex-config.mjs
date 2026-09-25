import { spawn } from 'node:child_process';
import readline from 'node:readline';

/** Use Codex's TOML editor so comments, inline tables and concurrent edits survive. */
export async function withCodexConfig({ env, cwd }, action) {
  const childEnv = { ...env };
  delete childEnv.SUPPORTPAGES_API_TOKEN;
  delete childEnv.SUPPORTPAGES_API_TOKEN_FILE;
  const child = spawn('codex', ['app-server', '--stdio'], { cwd, env: childEnv, stdio: ['pipe', 'pipe', 'ignore'] });
  let id = 0, closed = false;
  const pending = new Map();
  const failure = () => Error('Codex configuration could not be updated. Update Codex and rerun supportpages init.');
  const stop = () => {
    closed = true;
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(failure()); }
    pending.clear();
  };
  child.on('error', stop); child.on('exit', stop); child.stdin.on('error', stop);
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', line => {
    let value;
    try { value = JSON.parse(line); } catch { stop(); return; }
    const item = pending.get(value.id);
    if (!item) return;
    clearTimeout(item.timer); pending.delete(value.id);
    // Never echo configuration or raw errors: they can contain credentials.
    if (value.error) item.reject(failure()); else item.resolve(value.result);
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    if (closed) { reject(failure()); return; }
    const requestId = ++id;
    const timer = setTimeout(() => { pending.delete(requestId); reject(failure()); }, 10000);
    pending.set(requestId, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id: requestId, method, params }) + '\n');
  });
  try {
    await request('initialize', { clientInfo: { name: 'supportpages', version: '0.1.0' }, capabilities: {} });
    child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
    return await action(request);
  } finally {
    stop(); lines.close(); child.stdin.end();
    child.kill('SIGTERM');
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise(resolve => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 1000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
  }
}
