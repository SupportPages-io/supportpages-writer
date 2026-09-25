#!/usr/bin/env node
// Plugin SessionStart hook: make sure Chromium for article screenshots exists.
//
// Plugin installs run npm without lifecycle scripts, so puppeteer's Chromium
// download never happened. This hook returns immediately (it must not delay the
// session or print into its context) and, when Chromium is missing, starts the
// download in a detached process guarded by a lock.
//
//   node plugin-session.mjs              check; start a background download if needed
//   node plugin-session.mjs --download   download now (used by the background process)
import { spawn } from 'node:child_process';
import { mkdir, open, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { command } from './lib/install.mjs';
import { ensureRenderer, rendererReady } from './lib/renderer.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const engine = path.join(root, 'engine');
const dataDir = process.env.CLAUDE_PLUGIN_DATA || path.join(os.tmpdir(), 'supportpages-writer');
const lockFile = path.join(dataDir, 'chromium-download.lock');
const STALE_MS = 30 * 60 * 1000;
const quiet = (cmd, args, options = {}) => command(cmd, args, { ...options, capture: true });

/** True when a download started less than 30 minutes ago is still recorded. */
export async function downloadInProgress() {
  try { return Date.now() - (await stat(lockFile)).mtimeMs < STALE_MS; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

/** Start a detached download unless one is already running. */
export async function startDownload() {
  if (await downloadInProgress()) return;
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--download'], { detached: true, stdio: 'ignore', env: process.env });
  child.on('error', () => {});
  child.unref();
}

async function download() {
  await mkdir(dataDir, { recursive: true });
  let handle;
  try { handle = await open(lockFile, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST' || await downloadInProgress()) return;
    await rm(lockFile, { force: true });
    handle = await open(lockFile, 'wx');
  }
  try {
    await handle.writeFile(String(process.pid));
    await ensureRenderer(engine, quiet);
  } finally {
    await handle.close();
    await rm(lockFile, { force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.includes('--download')) await download();
    else if (!await rendererReady(engine, quiet)) await startDownload();
  } catch { /* A hook must never break the session. */ }
}

export { lockFile };
