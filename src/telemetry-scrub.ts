import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { SupportPagesError } from './errors.js';

/** Codes that point at a Writer or API bug. Every other SupportPagesError is an
 * expected account, plan or run state the user recovers from, not a crash. */
const unexpectedCodes = new Set(['internal_error', 'invalid_response', 'remote_error']);
const MAX_FRAMES = 30;

export type ErrorReport = { error_code: string; error_class: string; message?: string; frames: string[] };

/** Credentials, emails, URLs' paths and queries, and home directories never leave the device. */
export function scrubText(text: string, limit: number) {
  const home = os.homedir();
  let value = text.slice(0, limit * 2);
  if (home.length > 1) value = value.split(home).join('~');
  return value
    .replace(/\bsp_(?:local|live)_[A-Za-z0-9]+/g, '[token]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [token]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/(https?:\/\/[^\s/?#]+)[^\s)]*/g, '$1')
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, '[hex]')
    .slice(0, limit);
}

/** Keeps only the Writer's own frames by location; anything else on the
 * machine (the user's project, other packages) becomes <external>. */
export function scrubFrame(line: string, installRoot?: string) {
  let frame = line.trim().replace(/^at\s+/, '');
  if (installRoot) {
    for (const prefix of [pathToFileURL(installRoot).href, installRoot]) frame = frame.split(prefix).join('writer');
  }
  frame = frame
    .replace(/(^|[\s(])(?:file:\/\/)?\/[^\s:()]+/g, '$1<external>')
    .replace(/(^|[\s(])(?:file:\/\/\/)?[A-Za-z]:[\\/][^\s:()]+/g, '$1<external>');
  return scrubText(frame, 200);
}

/** A report for an unexpected error, or undefined for an expected one. */
export function errorReport(error: unknown, installRoot?: string): ErrorReport | undefined {
  if (error instanceof SupportPagesError && !unexpectedCodes.has(error.code)) return undefined;
  const name = error instanceof Error ? error.constructor.name || error.name : typeof error;
  const stack = error instanceof Error && typeof error.stack === 'string' ? error.stack : '';
  const frames = stack.split('\n').filter(line => /^\s+at\s/.test(line)).slice(0, MAX_FRAMES).map(line => scrubFrame(line, installRoot));
  return {
    error_code: error instanceof SupportPagesError ? error.code : 'internal_error',
    error_class: /^[A-Za-z][A-Za-z0-9_.]{0,63}$/.test(name) ? name : 'Error',
    // Only our own fail() text is sent; a foreign exception's message can quote
    // file contents, paths or server responses.
    ...(error instanceof SupportPagesError ? { message: scrubText(error.message, 300) } : {}),
    frames,
  };
}
