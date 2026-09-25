#!/usr/bin/env node
import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTerminal, Cancelled } from './lib/terminal.mjs';
import { runInstaller } from './lib/install.mjs';

const help = `SupportPages Writer — guided local setup

Usage: ./install.sh [options]
       node scripts/install.mjs [options]

The wizard builds the MCP server, prepares the article engine, and connects your coding
client globally. Optionally connect a repository through browser setup. Run it from a terminal on macOS or Linux.

  --workspace PATH       Connect this repository after installation
  --client NAME          codex, claude, both, or manual (auto-detected menu)
  --dev                  Connect to local RTFM (https://app.lvh.me:3443)
  --api-url URL          SupportPages.io app origin (default: https://app.supportpages.io)
  --skills-dir PATH      Use another engine directory instead of the bundled one
  --name NAME            Custom MCP connection name (default: supportpages or supportpages-dev)
  --skip-skills          Skip the trace hook and Chromium download
  --skip-dependencies    Use an already-built MCP checkout without npm ci/build
  --config-dir PATH      Private settings directory (~/.config/supportpages)
  --data-dir PATH        Installation data (~/.local/share/supportpages)
  --yes                  Noninteractive; requires --client
  -h, --help             Show this help without installing anything

Installation does not sign you in. Afterwards run supportpages setup once on this
computer, then supportpages init inside each project folder, or ask your coding
client to initialize SupportPages.io. Articles can be saved in the project without
an account; signing in (browser approval, private credentials) is needed only to
host them on a help centre.
`;
let options;
try {
  const stringOptions = ['workspace', 'client', 'api-url', 'skills-dir', 'name', 'config-dir', 'data-dir'];
  const booleanOptions = ['dev', 'skip-skills', 'skip-dependencies', 'yes'];
  options = parseArgs({ options: {
    ...Object.fromEntries(stringOptions.map(name => [name, { type: 'string' }])),
    ...Object.fromEntries(booleanOptions.map(name => [name, { type: 'boolean' }])),
    help: { type: 'boolean', short: 'h' },
  }}).values;
} catch {
  process.stderr.write('Invalid installer options. Run ./install.sh --help. Authentication happens in your browser.\n');
  process.exitCode = 2;
}
if (options) {
  if (options.help) process.stdout.write(help);
  else {
    try {
      if (process.platform === 'win32') throw new Error('Run this installer in WSL. The skills currently require a Unix shell.');
      const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
      if (nodeMajor < 22 || nodeMajor === 22 && nodeMinor < 12) throw new Error('Node.js 22.12 or later is required.');
      process.env.PATH = path.dirname(process.execPath) + path.delimiter + (process.env.PATH ?? '');
      if (!options.yes && (!process.stdin.isTTY || !process.stdout.isTTY)) throw new Error('Run ./install.sh in a terminal, or use --yes with explicit options.');
      await runInstaller(options, { ui: createTerminal(), installRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') });
    } catch (error) {
      process.stderr.write(`\n${error instanceof Cancelled ? '' : 'Setup stopped: '}${error.message}\n`);
      process.exitCode = error instanceof Cancelled ? 130 : 1;
    }
  }
}
