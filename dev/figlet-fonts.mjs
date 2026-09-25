#!/usr/bin/env node
// Preview a phrase in every figlet font, e.g. to pick the setup/init banner.
//
//   node dev/figlet-fonts.mjs                     # every font, "supportpages.io"
//   node dev/figlet-fonts.mjs --fits 80           # only fonts at most 80 columns wide
//   node dev/figlet-fonts.mjs --font slant        # fonts whose name matches
//   node dev/figlet-fonts.mjs "Hello" | less -R   # any text; page through the output
//
// figlet is not a dependency of the Writer. The first run installs it into
// ~/.cache/figlet-fonts so this repository's package files stay untouched.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  fits: { type: 'string' }, font: { type: 'string' }, help: { type: 'boolean', short: 'h' },
} });
if (values.help) {
  console.log('Usage: node dev/figlet-fonts.mjs [text] [--fits COLUMNS] [--font PATTERN]');
  process.exit(0);
}
const text = positionals.join(' ') || 'supportpages.io';
const maxWidth = values.fits ? Number(values.fits) : Infinity;
const pattern = values.font ? new RegExp(values.font, 'i') : undefined;

const cache = path.join(os.homedir(), '.cache', 'figlet-fonts');
if (!existsSync(path.join(cache, 'node_modules', 'figlet'))) {
  mkdirSync(cache, { recursive: true });
  process.stderr.write(`Installing figlet into ${cache}…\n`);
  execFileSync('npm', ['install', '--prefix', cache, '--no-save', '--silent', 'figlet@1'], { stdio: 'inherit' });
}
const figlet = createRequire(path.join(cache, 'package.json'))('figlet');

const color = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const bold = value => color ? `\x1b[1;36m${value}\x1b[0m` : value;
const dim = value => color ? `\x1b[90m${value}\x1b[0m` : value;

let shown = 0;
const fonts = figlet.fontsSync().filter(font => !pattern || pattern.test(font));
for (const font of fonts) {
  let art;
  try { art = figlet.textSync(text, { font }); } catch { continue; }
  // Drop blank rows so the sizes reflect the visible art.
  const rows = art.split('\n').map(row => row.trimEnd()).filter(row => row.trim());
  if (!rows.length) continue;
  const width = Math.max(...rows.map(row => Array.from(row).length));
  if (width > maxWidth) continue;
  shown++;
  console.log(`${bold(font)}  ${dim(`${width}×${rows.length}`)}`);
  console.log(`${rows.join('\n')}\n`);
}
process.stderr.write(`${shown} of ${fonts.length} fonts shown${Number.isFinite(maxWidth) ? ` (at most ${maxWidth} columns)` : ''}.\n`);
