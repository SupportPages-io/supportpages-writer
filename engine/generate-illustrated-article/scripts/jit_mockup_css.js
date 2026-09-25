#!/usr/bin/env node
/**
 * jit_mockup_css.js — Render-time local Tailwind JIT.
 *
 * The project's compiled branding.css is Tailwind-purged (it contains only the
 * classes the REAL app uses), so a mockup's own authored classes — arbitrary
 * values (`size-[18px]`), responsive variants (`lg:grid-cols-3`), plugin/component
 * classes — usually aren't in it. That's why inject_assets otherwise falls back to
 * the Tailwind Play CDN, which is unreliable in the headless Puppeteer render.
 *
 * This script instead compiles Tailwind LOCALLY against the MOCKUP HTML as the
 * content source, using the project's cached `css_build` recipe (its real entry +
 * config + plugins, so the theme/brand tokens apply) — producing exactly the
 * classes the mockups use. Output: <out_dir>/mockup.css. inject_assets.js links it
 * and drops the Play CDN when present.
 *
 * Usage: node jit_mockup_css.js <out_dir> <project_dir> <project_map.json>
 * Exit:  0 = mockup.css written; 3 = skipped (no usable recipe / not tailwind);
 *        1 = attempted but the local compile failed.
 * SAFETY: on any skip/failure the caller keeps its current CDN/fallback behaviour,
 * so this never regresses the pipeline.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function log(m) { console.error('  jit: ' + m); }
function skip(m) { log(m); process.exit(3); }
function fail(m) { log(m); process.exit(1); }

let [outDir, projectDir, projectMapPath] = process.argv.slice(2);
if (!outDir || !projectDir) skip('missing args (out_dir project_dir project_map.json)');
if (!fs.existsSync(outDir) || !fs.existsSync(projectDir)) skip('out_dir or project_dir missing');
// Resolve to ABSOLUTE now — callers pass a relative out_dir (e.g. output/articles/<slug>)
// but we run the compile from a different cwd (the assets/node_modules dir), so any
// relative -o / --content path would resolve against the wrong base and emit 0 bytes.
outDir = path.resolve(outDir);
projectDir = path.resolve(projectDir);

// --- Load the css_build recipe -------------------------------------------------
let recipe = null;
try { recipe = JSON.parse(fs.readFileSync(projectMapPath, 'utf8')).css_build; } catch (_) {}
if (!recipe) skip('no css_build recipe in project_map — keeping CDN');
if (recipe.method === 'fallback_synthesis') skip('recipe is fallback_synthesis — keeping CDN');
const twV = recipe.tw_version === 3 || recipe.tw_version === 4 ? recipe.tw_version : null;
if (!twV) skip('recipe is not a Tailwind build — keeping CDN');

// --- Gather the mockup HTML as the content to scan -----------------------------
const stepHtml = fs.readdirSync(outDir)
  .filter(f => /^(?:step_\d+|block_[a-z0-9]+(?:-[a-z0-9]+)*)\.html$/.test(f))
  .map(f => path.join(outDir, f));
if (!stepHtml.length) skip('no article mockup HTML to scan');

const outCss = path.join(outDir, 'mockup.css');
const entryRel = recipe.entry || '';
const entryAbs = entryRel ? path.resolve(projectDir, entryRel) : '';

// Run from the nearest ancestor of the entry (or projectDir) that has a
// node_modules — that's where detect-project installed tailwindcss + plugins, so
// `@import "tailwindcss"` / `@plugin` resolve. Falls back to projectDir.
function findCwd() {
  let dir = entryAbs ? path.dirname(entryAbs) : projectDir;
  const root = path.parse(dir).root;
  while (dir && dir !== root) {
    if (fs.existsSync(path.join(dir, 'node_modules', 'tailwindcss')) ||
        fs.existsSync(path.join(dir, 'node_modules', '@tailwindcss'))) return dir;
    dir = path.dirname(dir);
  }
  return projectDir;
}
const cwd = findCwd();

// Prefer a locally-installed Tailwind binary (detect-project installs one) so the
// render never depends on npx fetching @tailwindcss/cli over the network — the
// failure mode that silently drops back to the flaky Play CDN in constrained envs.
function twCli(v) {
  const localBin = path.join(cwd, 'node_modules', '.bin', 'tailwindcss');
  if (fs.existsSync(localBin)) return JSON.stringify(localBin);
  return v === 4 ? 'npx --yes @tailwindcss/cli@4' : 'npx --yes tailwindcss@3';
}

// --- Build the compile command from recipe fields (not string-munging) ---------
let cmd;
let tmpCfg = null;   // v3 temp config path — hoisted so the retry can rewrite it
if (twV === 4) {
  // v4 CLI: the real entry supplies @import "tailwindcss" + @plugin (theme/plugins);
  // repeated --content points scanning at the MOCKUP html (overrides source(none)).
  if (!entryAbs || !fs.existsSync(entryAbs)) skip('v4 recipe has no usable entry file');
  const content = stepHtml.map(h => `--content ${JSON.stringify(h)}`).join(' ');
  cmd = `${twCli(4)} -i ${JSON.stringify(entryAbs)} -o ${JSON.stringify(outCss)} ${content}`;
} else {
  // v3: spread the real config but override `content` to the mockup html, so the
  // theme/plugins from the real config apply while only the mockup's classes emit.
  const cfgRel = recipe.config;
  tmpCfg = path.join(outDir, '.jit_tw.config.js');
  if (cfgRel) {
    const cfgAbs = path.resolve(projectDir, cfgRel);
    fs.writeFileSync(tmpCfg,
      `const base = require(${JSON.stringify(cfgAbs)});\n` +
      `module.exports = { ...base, content: ${JSON.stringify(stepHtml)} };\n`);
  } else {
    fs.writeFileSync(tmpCfg, `module.exports = { content: ${JSON.stringify(stepHtml)} };\n`);
  }
  // v3 needs an entry with @tailwind directives; synthesize one if the recipe's
  // entry isn't a plain v3 entry.
  const tmpIn = path.join(outDir, '.jit_tw_in.css');
  fs.writeFileSync(tmpIn, '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n');
  cmd = `${twCli(3)} -c ${JSON.stringify(tmpCfg)} -i ${JSON.stringify(tmpIn)} -o ${JSON.stringify(outCss)}`;
}

// --- Run it (timed) ------------------------------------------------------------
// The render container is typically network-isolated, so the "keep the CDN"
// fallback is a mirage — a local compile is the ONLY thing that can work. The
// usual reason a first attempt fails is an unresolvable plugin: the real config
// `require()`s a plugin (`tailwind-scrollbar`, a v4 `@plugin`) that isn't in the
// render env's node_modules (detect-time installs don't always persist, pnpm
// symlinks dangle). A missing PLUGIN must not sink the whole compile — the
// mockup's own utility classes (`size-[18px]`, `grid-cols-3`, responsive
// variants) are theme/plugin-independent and the brand theme is already carried
// by the separately-linked `branding.css`. So on failure, retry once with a
// minimal, plugin-free config/entry rather than surrendering to the CDN.
log(`(cwd=${cwd}, tw v${twV}) compiling mockup classes -> ${path.basename(outCss)}`);
const buildLog = path.join(outDir, 'mockup_build.log');
function runCompile(c) {
  return execFileSync('bash', ['-c', `cd ${JSON.stringify(cwd)} && ${c} 2>&1`],
    { timeout: 120000, encoding: 'utf8' });
}
let out = '', ok = false;
try { out = runCompile(cmd); ok = true; }
catch (e) { out = (e.stdout || '') + (e.stderr || '') + '\n' + String(e.message || e); }

if (!ok && twV !== 4 && recipe.config) {
  // v3: drop the real config's theme+plugins; keep only the mockup content.
  log('config load failed (likely a missing plugin) — retrying with a minimal plugin-free config');
  fs.writeFileSync(tmpCfg, `module.exports = { content: ${JSON.stringify(stepHtml)} };\n`);
  try { out += '\n--- retry (minimal config) ---\n' + runCompile(cmd); ok = true; }
  catch (e) { out += '\n--- retry (minimal config) FAILED ---\n' + (e.stdout || '') + (e.stderr || '') + '\n' + String(e.message || e); }
} else if (!ok && twV === 4 && entryAbs) {
  // v4: the real entry's `@plugin`/`@import` lines can fail to resolve; retry
  // with a bare `@import "tailwindcss"` entry (default theme, no plugins).
  log('v4 entry compile failed (likely a missing @plugin) — retrying with a bare tailwindcss entry');
  const bareIn = path.join(outDir, '.jit_tw_in.css');
  fs.writeFileSync(bareIn, '@import "tailwindcss";\n');
  const content = stepHtml.map(h => `--content ${JSON.stringify(h)}`).join(' ');
  const bareCmd = `${twCli(4)} -i ${JSON.stringify(bareIn)} -o ${JSON.stringify(outCss)} ${content}`;
  try { out += '\n--- retry (bare v4 entry) ---\n' + runCompile(bareCmd); ok = true; }
  catch (e) { out += '\n--- retry (bare v4 entry) FAILED ---\n' + (e.stdout || '') + (e.stderr || '') + '\n' + String(e.message || e); }
}

if (!ok && twV === 4) {
  // Last resort: even the bare `@import "tailwindcss"` needs the tailwindcss
  // PACKAGE resolvable from the filesystem, and workspace monorepos (bun/pnpm)
  // often have no usable node_modules at render time at all. Scratch-install
  // tailwindcss@4 into a tmp cache (persists across runs on the same machine)
  // and import it by absolute path — mirroring the isolated build detect-time
  // compiles already use. Network-dependent like the npx CLI fetch above; in a
  // fully offline env this fails harmlessly into the existing CDN fallback.
  const scratch = path.join(os.tmpdir(), 'rtfm-jit-tw4');
  const pkgCss = path.join(scratch, 'node_modules', 'tailwindcss', 'index.css');
  try {
    if (!fs.existsSync(pkgCss)) {
      log('tailwindcss package unresolvable — scratch-installing tailwindcss@4 (cached in tmp)');
      execFileSync('bash', ['-c',
        `npm install --prefix ${JSON.stringify(scratch)} --no-save --no-audit --no-fund --ignore-scripts tailwindcss@4 2>&1`],
        { timeout: 120000, encoding: 'utf8' });
    }
    if (fs.existsSync(pkgCss)) {
      const absIn = path.join(outDir, '.jit_tw_in.css');
      fs.writeFileSync(absIn, `@import ${JSON.stringify(pkgCss)};\n`);
      const content = stepHtml.map(h => `--content ${JSON.stringify(h)}`).join(' ');
      const absCmd = `${twCli(4)} -i ${JSON.stringify(absIn)} -o ${JSON.stringify(outCss)} ${content}`;
      out += '\n--- retry (scratch-installed tailwindcss) ---\n' + runCompile(absCmd);
      ok = true;
    }
  } catch (e) { out += '\n--- retry (scratch install) FAILED ---\n' + (e.stdout || '') + (e.stderr || '') + '\n' + String(e.message || e); }
}
try { fs.writeFileSync(buildLog, `CMD: ${cmd}\nCWD: ${cwd}\nok=${ok}\n--- output ---\n${out}\n`); } catch (_) {}
if (!ok) fail('local Tailwind compile failed — keeping CDN\n' + out.split('\n').slice(-8).join('\n'));

// Clean temp files
for (const t of ['.jit_tw.config.js', '.jit_tw_in.css']) {
  try { fs.unlinkSync(path.join(outDir, t)); } catch (_) {}
}

let bytes = 0;
try { bytes = fs.statSync(outCss).size; } catch (_) {}
if (bytes < 2000) fail(`mockup.css too small (${bytes}b) — keeping CDN`);
log(`wrote ${path.basename(outCss)} (${bytes} bytes)`);
process.exit(0);
