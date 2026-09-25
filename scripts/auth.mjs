#!/usr/bin/env node
import { parseArgs } from 'node:util';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createTerminal } from './lib/terminal.mjs';
import { apiOrigin, ApiClient, defaultOrigin } from '../dist/api.js';
import { credentialLocation, defaultConfigDir } from '../dist/session.js';
import { saveTokenFile } from '../dist/credentials.js';

/** Manual fallback: paste a token created in the web app and save it as this device's credential. */
export async function authenticate(options, { ui, fetcher = fetch } = {}) {
  const dev = options.dev === true;
  const origin = apiOrigin(options['api-url'] ?? defaultOrigin(dev), dev);
  ui.line(`Sign this device in to ${origin} with a token\nCreate a token for all help centres at ${origin}/settings/local-api-tokens\nUse read and import permissions, plus create projects and publish if required.`);
  const token = (await ui.secret('Paste API token (hidden)')).trim();
  if (!/^sp_local_[a-f0-9]{64}$/.test(token)) throw new Error('Invalid token format. No credential was saved.');
  const settings = await new ApiClient(origin, token, fetcher, dev).request('GET', '/mcp/settings');
  const account = settings?.account;
  if (!account || typeof account.id !== 'string' || !/^[1-9][0-9]*$/.test(account.id) || typeof account.email !== 'string') throw new Error('The API returned an invalid account. No credential was saved.');
  const { filename } = credentialLocation(origin, path.resolve(options['config-dir'] ?? defaultConfigDir()));
  await saveTokenFile(filename, origin, token, { id: account.id, email: account.email });
  ui.line(`Token verified and saved privately for ${account.email}. Run supportpages init inside a project folder to connect it to a help centre.`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    let options;
    try { options = parseArgs({ options: { workspace: { type: 'string' }, 'api-url': { type: 'string' }, 'config-dir': { type: 'string' }, dev: { type: 'boolean' } } }).values; }
    catch { throw new Error('Invalid authentication options. Tokens must only be entered at the hidden prompt.'); }
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Run this command in your own interactive terminal.');
    await authenticate(options, { ui: createTerminal() });
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
