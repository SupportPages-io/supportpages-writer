#!/usr/bin/env node
/*
 * detect_structure.js — emit the deterministic skeleton of project_map.json.
 *
 * The article/walkthrough skills re-derive the same project structure on every
 * run (where routes/controllers/views live, which layouts exist, the shared
 * chrome). This script captures that once so generators can read it instead of
 * re-running the grep/ls/find discovery flurry (see tools/analyze_traces.py).
 *
 * It fills the cheap, regex/fs-derivable fields:
 *   framework, dir_map, layouts[] (+ body_class), global_chrome[]
 * It leaves default_user_assumptions[] empty and route_index{} empty — those
 * are filled lazily by the generator skills (detect-project leaves them empty)
 * respectively.
 *
 * Usage:
 *   node detect_structure.js <out_json> <codebase_dir> [framework] [app_type] [app_type_source]
 *
 * app_type/app_type_source, when given, are stamped verbatim into the map
 * (source ∈ hint|auto|default — how STEP 0 decided the type). Stamping here
 * rather than in the model-executed enrichment keeps the record deterministic.
 *
 * Node built-ins only (matches detect_static.js). No deps.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const TEMPLATE_EXT = /\.(html\.(erb|haml|slim)|heex|html|blade\.php|jsx|tsx|vue)$/;
const BODY_CLASS_RE = /<body[^>]*\sclass=["']([^"']*)["']/i;

// Per-framework structural conventions. layoutsDir/chrome use directory reads
// (not full globbing) so this stays built-in-only and fast.
const FRAMEWORKS = {
  rails: {
    dir_map: { routes: 'config/routes.rb', controllers: 'app/controllers', views: 'app/views' },
    layoutsDir: 'app/views/layouts',
    leafRe: /\.html\.(erb|haml|slim)$/,
  },
  phoenix: {
    dir_map: { routes: 'lib', controllers: 'lib', views: 'lib' },
    layoutsDir: null, // heex layouts vary by app name; resolved by glob below
    leafRe: /\.heex$/,
  },
  django: {
    dir_map: { routes: '.', controllers: '.', views: '.' },
    layoutsDir: null,
    leafRe: /\.html$/,
  },
  laravel: {
    dir_map: { routes: 'routes/web.php', controllers: 'app/Http/Controllers', views: 'resources/views' },
    layoutsDir: 'resources/views/layouts',
    leafRe: /\.blade\.php$/,
  },
  'next-app': {
    dir_map: { routes: 'app', controllers: 'app', views: 'app' },
    layoutsDir: 'app',
    leafRe: /^layout\.(jsx|tsx)$/,
  },
  'next-pages': {
    dir_map: { routes: 'pages', controllers: 'pages/api', views: 'pages' },
    layoutsDir: 'pages',
    leafRe: /^_app\.(jsx|tsx)$/,
  },
};

function exists(base, rel) {
  try { fs.accessSync(path.join(base, rel)); return true; } catch { return false; }
}

function detectFramework(base) {
  const has = (f) => exists(base, f);
  if (has('Gemfile') && has('config/routes.rb')) return 'rails';
  if (has('mix.exs')) return 'phoenix';
  if (has('artisan')) return 'laravel';
  if (has('manage.py')) return 'django';
  if (has('next.config.js') || has('next.config.mjs') || has('next.config.ts')) {
    return has('app') ? 'next-app' : 'next-pages';
  }
  return 'unknown';
}

function readBodyClass(file) {
  try {
    const txt = fs.readFileSync(file, 'utf8').slice(0, 8000);
    const m = txt.match(BODY_CLASS_RE);
    return m ? m[1].trim() : null;
  } catch { return null; }
}

// Find layout files + chrome partials in a known layouts dir.
function scanLayoutsDir(base, dirRel, leafRe) {
  const layouts = [];
  const chrome = [];
  const abs = path.join(base, dirRel);
  let entries;
  try { entries = fs.readdirSync(abs); } catch { return { layouts, chrome }; }
  for (const name of entries) {
    if (!leafRe.test(name) && !name.endsWith('.erb') && !name.endsWith('.haml')
        && !name.endsWith('.slim') && !name.endsWith('.heex')) continue;
    const rel = path.join(dirRel, name);
    if (name.startsWith('_')) {
      chrome.push(rel);
    } else if (leafRe.test(name)) {
      layouts.push(rel);
    }
  }
  return { layouts, chrome };
}

function gitSha(base) {
  try {
    return execSync('git rev-parse HEAD', { cwd: base, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch { return null; }
}

// Stamp the running skills version + this file's content hash to stderr, so a
// debug bundle reveals exactly which code ran (vendored copies of the skills can
// drift behind a release). Hash is authoritative.
function logSkillsVersion() {
  const here = path.dirname(fs.realpathSync(__filename));
  let version = 'unknown';
  for (const c of [path.join(here, '..', '..', 'VERSION'), path.join(here, '..', 'VERSION')]) {
    try { const v = fs.readFileSync(c, 'utf8').trim(); if (v) { version = v; break; } } catch { /* next */ }
  }
  let sha = '?';
  try { sha = require('crypto').createHash('sha256').update(fs.readFileSync(fs.realpathSync(__filename))).digest('hex').slice(0, 8); } catch { /* ignore */ }
  console.error(`rtfm-skills detect_structure.js — v${version} (sha ${sha})`);
}

function main() {
  logSkillsVersion();
  const [outJson, codebaseArg, frameworkArg, appTypeArg, appTypeSourceArg] = process.argv.slice(2);
  if (!outJson || !codebaseArg) {
    console.error('Usage: detect_structure.js <out_json> <codebase_dir> [framework] [app_type] [app_type_source]');
    process.exit(1);
  }
  const base = path.resolve(codebaseArg);
  let framework = frameworkArg && frameworkArg !== 'unknown' ? frameworkArg : detectFramework(base);

  const fw = FRAMEWORKS[framework] || null;
  const dir_map = fw ? { ...fw.dir_map } : {};
  // Verify each mapped path actually exists; drop the ones that don't.
  for (const [k, v] of Object.entries(dir_map)) {
    if (!exists(base, v)) delete dir_map[k];
  }

  let layouts = [];
  let chrome = [];
  if (fw && fw.layoutsDir && exists(base, fw.layoutsDir)) {
    const scan = scanLayoutsDir(base, fw.layoutsDir, fw.leafRe);
    chrome = scan.chrome;
    layouts = scan.layouts.map((rel) => {
      const isDefault = /application|app|layout/i.test(path.basename(rel));
      const out = { file: rel, body_class: readBodyClass(path.join(base, rel)) };
      // area = filename without the extension chain, when it isn't the default
      const stem = path.basename(rel).replace(/\..*$/, '');
      if (!/^application$|^layout$|^app$/i.test(stem)) out.area = stem;
      if (isDefault && /application|^app\./i.test(path.basename(rel))) out.default = true;
      return out;
    });
    // Guarantee exactly one default if we found any layouts.
    if (layouts.length && !layouts.some((l) => l.default)) layouts[0].default = true;
  }

  const map = {
        schema_version: 5,
    framework,
    ...(appTypeArg ? { app_type: appTypeArg, app_type_source: appTypeSourceArg || 'default' } : {}),
    git_sha: gitSha(base),
    generated_at: new Date().toISOString(),
    dir_map,
    layouts,
    global_chrome: chrome,
    default_user_assumptions: [],   // filled lazily by the generator skills
    route_index: {},                // accumulated by the generators
  };

  fs.mkdirSync(path.dirname(outJson), { recursive: true });
  fs.writeFileSync(outJson, JSON.stringify(map, null, 2));
  console.log(`project_map: framework=${framework}, ${layouts.length} layout(s), ` +
    `${chrome.length} chrome partial(s) -> ${outJson}`);
}

main();
