#!/usr/bin/env node
/**
 * detect_branding.js — Identify the CSS framework + design tokens used by the
 * codebase at <cwd_to_scan> and produce branding.json (+ optional copy of the
 * compiled CSS) at <output_dir>. Static parsing only — no LLM, no API call.
 * Runs in ~100ms on a typical Rails or Next.js project.
 *
 * Usage: detect_branding.js <output_dir> <cwd_to_scan>
 *
 * Detection passes (results merged into one output object):
 *   1. Framework identification (Tailwind, Bootstrap, Bulma, Foundation, MUI, custom, none)
 *   2. Compiled CSS extraction (find the built bundle, copy if ≤500KB)
 *   3. Source CSS :root + .dark blocks
 *   4. SCSS variable extraction ($primary, $secondary, etc.)
 *   5. Tailwind config theme.extend
 *   6. Default brand colors from Ruby model code (Rails-style .presence || "#hex")
 *   7. Google Fonts URLs from layout templates
 *   8. External stylesheet <link> URLs from layouts
 */

const fs = require('fs');
const path = require('path');

const MAX_COMPILED_CSS_BYTES = 500 * 1024;
const SCAN_FILE_LIMIT = 10000;
const SKIP_DIRS = new Set([
    'node_modules', '.git', '.next', '.nuxt', 'tmp', 'log', 'logs',
    'coverage', '.cache', '.parcel-cache', 'bower_components', 'vendor',
    '.DS_Store', '.bundle',
]);

// ─── Filesystem helpers ──────────────────────────────────────────────────────

function readFileSafe(p) {
    try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}
function fileExists(p) {
    try { return fs.statSync(p).isFile(); } catch { return false; }
}
function dirExists(p) {
    try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function* walk(root, opts = {}) {
    const maxDepth = opts.maxDepth ?? 8;
    const stack = [[root, 0]];
    let yielded = 0;
    while (stack.length) {
        const [dir, depth] = stack.pop();
        if (depth > maxDepth) continue;
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
            if (SKIP_DIRS.has(e.name)) continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
                stack.push([full, depth + 1]);
            } else if (e.isFile()) {
                yield full;
                if (++yielded > SCAN_FILE_LIMIT) return;
            }
        }
    }
}

function findFiles(root, predicate, maxResults = 200) {
    const results = [];
    for (const f of walk(root)) {
        if (predicate(f)) {
            results.push(f);
            if (results.length >= maxResults) break;
        }
    }
    return results;
}

// ─── Pass 1: Framework identification ────────────────────────────────────────

const FRAMEWORK_SIGNALS = {
    tailwind: {
        package: ['tailwindcss'],
        gem: ['tailwindcss-rails'],
        configs: ['tailwind.config.js', 'tailwind.config.ts', 'tailwind.config.cjs', 'tailwind.config.mjs'],
        cssImports: [/@tailwind\s+(base|components|utilities)/, /@import\s+["']tailwindcss/i],
    },
    bootstrap: {
        package: ['bootstrap'],
        gem: ['bootstrap', 'bootstrap-sass'],
        cssImports: [/@import\s+["']bootstrap/i, /@use\s+["']bootstrap/i],
        classPatterns: [/\bbtn\s+btn-(primary|secondary|success|danger|warning|info|light|dark)\b/, /\bnavbar-(brand|nav|expand|toggler)/],
    },
    webpixels: {
        // Bootstrap-compatible utility/component library with extra primitives:
        // .btn-neutral, .btn-square, .avatar, .icon, .text-heading, etc.
        // Detected as its own framework so downstream uses the right CDN URL
        // and so refinement knows the project has extra component classes.
        package: ['@webpixels/css'],
        cssImports: [/@import\s+["']@webpixels\/css/i, /@use\s+["']@webpixels\/css/i],
        classPatterns: [/\bavatar(\s+avatar-(xs|sm|md|lg|xl|circle|square))?\b/, /\bbtn-neutral\b/, /\bbtn-square\b/, /\btext-heading\b/, /\bbg-section-secondary\b/],
    },
    bulma: {
        package: ['bulma'],
        gem: ['bulma-rails'],
        cssImports: [/@import\s+["']bulma/i, /@use\s+["']bulma/i],
        classPatterns: [/\bis-(primary|info|warning|danger|success|link)\b/, /\bbutton\s+is-/],
    },
    foundation: {
        package: ['foundation-sites'],
        gem: ['foundation-rails'],
        cssImports: [/@import\s+["']foundation/i],
    },
    mui: {
        package: ['@mui/material', '@mui/core', '@material-ui/core'],
        jsImports: [/from\s+["']@mui\//, /from\s+["']@material-ui\//, /createTheme\s*\(/],
    },
};

function detectFrameworks(cwd) {
    const packageJsonPath = path.join(cwd, 'package.json');
    const packageDeps = {};
    if (fileExists(packageJsonPath)) {
        try {
            const pkg = JSON.parse(readFileSafe(packageJsonPath));
            Object.assign(packageDeps, pkg.dependencies || {}, pkg.devDependencies || {});
        } catch { /* invalid json */ }
    }

    const gemfile = readFileSafe(path.join(cwd, 'Gemfile')) || '';
    const gemfileLock = readFileSafe(path.join(cwd, 'Gemfile.lock')) || '';

    const scores = {};
    const versions = {};

    for (const [name, signals] of Object.entries(FRAMEWORK_SIGNALS)) {
        let score = 0;
        let version = null;

        for (const dep of (signals.package || [])) {
            if (packageDeps[dep]) { score += 3; version = version || packageDeps[dep]; }
        }
        for (const gem of (signals.gem || [])) {
            if (new RegExp(`\\bgem\\s+["']${gem}["']`, 'i').test(gemfile)) {
                score += 3;
                const lockMatch = gemfileLock.match(new RegExp(`\\b${gem}\\s+\\(([\\d.]+)\\)`, 'i'));
                if (lockMatch) version = version || lockMatch[1];
            }
        }
        for (const cfg of (signals.configs || [])) {
            if (fileExists(path.join(cwd, cfg))) score += 5;
        }

        scores[name] = score;
        if (version) versions[name] = version;
    }

    // Scan CSS files for @import / @tailwind
    const cssFiles = findFiles(cwd, f => /\.(css|scss|sass)$/i.test(f), 200);
    for (const f of cssFiles) {
        const content = readFileSafe(f);
        if (!content) continue;
        for (const [name, signals] of Object.entries(FRAMEWORK_SIGNALS)) {
            for (const re of (signals.cssImports || [])) {
                if (re.test(content)) scores[name] = (scores[name] || 0) + 2;
            }
        }
    }

    // Scan JS for MUI imports
    const jsFiles = findFiles(cwd, f => /\.(jsx?|tsx?)$/i.test(f), 200);
    for (const f of jsFiles) {
        const content = readFileSafe(f);
        if (!content) continue;
        for (const re of (FRAMEWORK_SIGNALS.mui.jsImports || [])) {
            if (re.test(content)) scores.mui = (scores.mui || 0) + 1;
        }
    }

    // Scan templates for class-name patterns
    const templateFiles = findFiles(cwd, f => /\.(erb|haml|slim|heex|eex|html|jsx|tsx|vue|svelte)$/i.test(f), 200);
    const templateBlob = templateFiles.map(f => readFileSafe(f) || '').join('\n');
    for (const [name, signals] of Object.entries(FRAMEWORK_SIGNALS)) {
        for (const re of (signals.classPatterns || [])) {
            const matches = templateBlob.match(new RegExp(re.source, 'g'));
            if (matches) scores[name] = (scores[name] || 0) + Math.min(matches.length, 3);
        }
    }

    const winners = Object.entries(scores)
        .filter(([_, s]) => s >= 3)
        .sort((a, b) => b[1] - a[1])
        .map(([n]) => n);

    if (winners.length === 0) {
        if (cssFiles.length > 0) return { framework: 'custom', version: null };
        return { framework: 'none', version: null };
    }

    const primary = winners[0];
    return {
        framework: winners.length > 1 ? winners.join('+') : primary,
        version: versions[primary] || null,
    };
}

// ─── Pass 2: Compiled CSS extraction ─────────────────────────────────────────

function findCompiledCss(cwd) {
    const candidates = [];
    for (const f of walk(cwd)) {
        if (!f.endsWith('.css')) continue;
        const rel = path.relative(cwd, f);
        if (!/^(app\/assets\/builds|public\/(build|css|assets)|dist|build|static\/css|_next\/static\/css)\//.test(rel)) continue;
        try {
            const size = fs.statSync(f).size;
            candidates.push({ path: f, rel, size });
        } catch { /* skip */ }
    }
    if (candidates.length === 0) return null;
    // Prefer non-vendor files (not named bootstrap.min.css etc.), then largest
    candidates.sort((a, b) => {
        const aVendor = /\b(bootstrap|bulma|foundation|normalize|reset)\b/i.test(a.rel) ? 1 : 0;
        const bVendor = /\b(bootstrap|bulma|foundation|normalize|reset)\b/i.test(b.rel) ? 1 : 0;
        return aVendor - bVendor || b.size - a.size;
    });
    return candidates[0];
}

// ─── Pass 3: Source CSS :root + .dark extraction ─────────────────────────────

function extractRootBlocks(cwd) {
    let rootCss = null;
    let darkCss = null;
    let rootSource = null;
    for (const f of walk(cwd)) {
        if (!/\.(css|scss)$/i.test(f)) continue;
        const rel = path.relative(cwd, f);
        if (!/(app\/assets\/(tailwind|stylesheets)|src\/|styles\/|app\/styles\/)/.test(rel)) continue;
        const content = readFileSafe(f);
        if (!content) continue;
        if (!rootCss) {
            const m = content.match(/:root\s*\{([^}]*)\}/m);
            if (m) { rootCss = m[1].trim(); rootSource = rel; }
        }
        if (!darkCss) {
            const m = content.match(/\.dark\s*\{([^}]*)\}/m);
            if (m) darkCss = m[1].trim();
        }
        if (rootCss && darkCss) break;
    }
    return { rootCss, darkCss, rootSource };
}

// ─── Pass 3b: SCSS / Tailwind entry-point detection ──────────────────────────

// The "entry" is the single file that @imports everything else — what the
// project's build pipeline feeds into sass/tailwindcss. Without this,
// compile_css.sh has nothing to compile and falls back to CDN.

function extractScssEntry(cwd) {
    const candidates = [
        // Webpacker / shakapacker (Rails) — common when Rails uses webpack
        'app/frontend/packs/application.scss',
        'app/frontend/packs/application.css.scss',
        'app/frontend/styling/application.scss',
        'app/javascript/packs/application.scss',
        // Rails asset pipeline
        'app/assets/stylesheets/application.scss',
        'app/assets/stylesheets/application.sass',
        'app/assets/stylesheets/application.css.scss',
        // Generic Node / framework patterns
        'src/styles/main.scss',
        'src/styles/application.scss',
        'src/styles/globals.scss',
        'src/styles/index.scss',
        'src/main.scss',
        'src/index.scss',
        'src/app.scss',
        'styles/main.scss',
        'styles/globals.scss',
        'assets/scss/main.scss',
        'assets/styles/main.scss',
    ];
    for (const p of candidates) {
        const full = path.join(cwd, p);
        if (!fileExists(full)) continue;
        const content = readFileSafe(full) || '';
        // Verify it's actually an entry — contains @import / @use directives
        if (/@(import|use)\s+["][^"]+["]/.test(content) || /@(import|use)\s+'[^']+'/.test(content)) {
            return p;
        }
    }
    return null;
}

function extractTailwindEntry(cwd) {
    const candidates = [
        'app/assets/tailwind/application.css',
        'app/assets/tailwind/index.css',
        'app/assets/stylesheets/application.tailwind.css',
        'src/styles/globals.css',
        'src/styles/main.css',
        'src/styles/tailwind.css',
        'src/index.css',
        'src/app.css',
        'styles/globals.css',
        'styles/main.css',
        'app/globals.css',                  // Next.js app router
        'app/[locale]/globals.css',
    ];
    for (const p of candidates) {
        const full = path.join(cwd, p);
        if (!fileExists(full)) continue;
        const content = readFileSafe(full) || '';
        if (/@tailwind\s+(base|components|utilities)/.test(content) ||
            /@import\s+["']tailwindcss/.test(content)) {
            return p;
        }
    }
    return null;
}

// ─── Pass 4: SCSS variables ──────────────────────────────────────────────────

function extractScssVars(cwd) {
    const vars = {};
    const sources = [];
    const candidates = [
        'app/assets/stylesheets/_variables.scss',
        'app/assets/stylesheets/_colors.scss',
        'app/assets/stylesheets/_brand.scss',
        'app/assets/stylesheets/_theme.scss',
        'src/styles/_variables.scss',
        'styles/_variables.scss',
    ];
    for (const p of candidates) {
        const full = path.join(cwd, p);
        if (!fileExists(full)) continue;
        const content = readFileSafe(full) || '';
        sources.push(p);
        const re = /\$([a-z][\w-]*)\s*:\s*(#[\da-f]{3,8}|[a-z][\w-]*)\s*(?:!default)?\s*;/gi;
        for (const m of content.matchAll(re)) {
            const name = m[1].toLowerCase();
            if (/^(primary|secondary|accent|brand|brand-color|color-primary|theme-primary|success|warning|danger|info|body-color)$/.test(name)) {
                vars[name] = m[2];
            }
        }
    }
    return { vars, sources };
}

// ─── Pass 5: Tailwind config parsing ─────────────────────────────────────────

function extractTailwindExtend(cwd) {
    for (const name of ['tailwind.config.js', 'tailwind.config.ts', 'tailwind.config.cjs', 'tailwind.config.mjs']) {
        const full = path.join(cwd, name);
        if (!fileExists(full)) continue;
        const content = readFileSafe(full) || '';
        // Best-effort regex extract of the extend block. Matches "extend: { ... }" allowing
        // one level of nesting (handles colors: { brand: '#...' } common case).
        const m = content.match(/extend\s*:\s*(\{(?:[^{}]|\{[^{}]*\})*\})/m);
        return { extend: m ? m[1] : null, source: name };
    }
    return { extend: null, source: null };
}

// ─── Pass 6: Default brand colors from Ruby model code ───────────────────────

function extractDefaultBrandColors(cwd) {
    const colors = {};
    const dynamic_sources = [];  // {key, hex, source_file, source_kind, snippet}
    const sources = new Set();

    function record(kind, hex, file, sourceKind, snippet) {
        const key = kind.includes('accent') ? 'accent'
            : kind.includes('gradient') ? 'gradient_start'
            : kind.includes('secondary') ? 'secondary'
            : 'primary';
        if (!colors[key]) {
            colors[key] = hex;
            sources.add(file);
            dynamic_sources.push({ key, hex, source_file: file, source_kind: sourceKind, snippet: snippet.trim().slice(0, 120) });
        }
    }

    // 1. Ruby model / helper / service / job code
    const rubyDirs = ['app/models', 'app/services', 'app/jobs', 'app/helpers', 'app/controllers', 'config/initializers', 'lib'];
    for (const d of rubyDirs) {
        const full = path.join(cwd, d);
        if (!dirExists(full)) continue;
        for (const f of walk(full)) {
            if (!f.endsWith('.rb')) continue;
            const content = readFileSafe(f);
            if (!content) continue;
            const rel = path.relative(cwd, f);

            // Pattern A: foo_color.presence || "#hex"   (RTFM model-default style)
            for (const m of content.matchAll(/(\w*?(?:primary|brand|accent|gradient|secondary)\w*)_color[^"\n]*?\.presence\s*\|\|\s*["'](#[0-9a-fA-F]{3,8})["']/gi)) {
                record(m[1].toLowerCase(), m[2], rel, 'model_presence_default', m[0]);
            }

            // Pattern B: ENV.fetch("PRIMARY_COLOR", "#hex")   (env-var with default)
            for (const m of content.matchAll(/ENV\.fetch\s*\(\s*["'][^"']*?(?:PRIMARY|BRAND|ACCENT|GRADIENT|SECONDARY)[^"']*?["']\s*,\s*["'](#[0-9a-fA-F]{3,8})["']/gi)) {
                const kind = (m[0].match(/(PRIMARY|BRAND|ACCENT|GRADIENT|SECONDARY)/i) || [''])[0].toLowerCase();
                record(kind, m[1], rel, 'env_fetch_default', m[0]);
            }

            // Pattern C: ENV["FOO_COLOR"] || "#hex"
            for (const m of content.matchAll(/ENV\s*\[\s*["'][^"']*?(?:PRIMARY|BRAND|ACCENT|GRADIENT|SECONDARY)[^"']*?["']\s*\]\s*\|\|\s*["'](#[0-9a-fA-F]{3,8})["']/gi)) {
                const kind = (m[0].match(/(PRIMARY|BRAND|ACCENT|GRADIENT|SECONDARY)/i) || [''])[0].toLowerCase();
                record(kind, m[1], rel, 'env_or_default', m[0]);
            }

            // Pattern D: PRIMARY_COLOR = "#hex"   (top-level constant)
            for (const m of content.matchAll(/(?:^|\s)(PRIMARY|BRAND|ACCENT|GRADIENT|SECONDARY)(?:_COLOR)?\s*=\s*["'](#[0-9a-fA-F]{3,8})["']/gm)) {
                record(m[1].toLowerCase(), m[2], rel, 'ruby_constant', m[0]);
            }

            // Pattern E: DEFAULT_COLORS = %w[#abc #def]
            const defMatch = content.match(/DEFAULT_COLORS?\s*=\s*%w\[\s*((?:#[0-9a-fA-F]{3,8}\s*)+)\]/);
            if (defMatch) {
                const hexes = defMatch[1].trim().split(/\s+/);
                if (hexes[0]) record('primary', hexes[0], rel, 'default_colors_constant', defMatch[0]);
                if (hexes[1]) record('accent', hexes[1], rel, 'default_colors_constant', defMatch[0]);
            }
        }
    }

    // 2. DB schema column defaults — db/schema.rb: t.string "primary_color", default: "#hex"
    const schemaPath = path.join(cwd, 'db/schema.rb');
    if (fileExists(schemaPath)) {
        const content = readFileSafe(schemaPath) || '';
        for (const m of content.matchAll(/t\.\w+\s+["'](\w*?(?:primary|brand|accent|gradient|secondary)\w*_color)["'][^,\n]*?,\s*default:\s*["'](#[0-9a-fA-F]{3,8})["']/gi)) {
            const kind = m[1].toLowerCase().replace(/_color$/, '');
            record(kind, m[2], 'db/schema.rb', 'schema_column_default', m[0]);
        }
    }

    // 3. YAML / config file defaults (Settings, Rails config) — config/*.yml,
    // config/settings.yml, config/branding.yml
    const yamlCandidates = ['config/settings.yml', 'config/branding.yml', 'config/theme.yml'];
    for (const p of yamlCandidates) {
        const full = path.join(cwd, p);
        if (!fileExists(full)) continue;
        const content = readFileSafe(full) || '';
        for (const m of content.matchAll(/(\w*?(?:primary|brand|accent|gradient|secondary)\w*?_color)\s*:\s*["']?(#[0-9a-fA-F]{3,8})/gi)) {
            const kind = m[1].toLowerCase().replace(/_color$/, '');
            record(kind, m[2], p, 'yaml_default', m[0]);
        }
    }

    return { colors, sources: Array.from(sources), dynamic_sources };
}

// ─── Pass 7+8: stylesheets from layout templates ─────────────────────────────

function extractStylesheets(cwd) {
    const layoutFiles = [];
    const candidateDirs = ['app/views/layouts', 'app', 'pages', 'src', 'public'];
    for (const d of candidateDirs) {
        const full = path.join(cwd, d);
        if (!dirExists(full)) continue;
        for (const f of walk(full, { maxDepth: 4 })) {
            if (!/\.(erb|haml|slim|heex|eex|html|jsx|tsx)$/i.test(f)) continue;
            const base = path.basename(f).toLowerCase();
            if (base.startsWith('layout') || base.startsWith('application')
                || base.startsWith('_document') || base.startsWith('root_layout')
                || base === 'app.tsx' || base === 'app.jsx' || base === 'index.html') {
                layoutFiles.push(f);
            }
        }
    }
    // Top-level common files
    for (const p of ['index.html', 'public/index.html']) {
        const full = path.join(cwd, p);
        if (fileExists(full) && !layoutFiles.includes(full)) layoutFiles.push(full);
    }

    const googleFonts = new Set();
    const externalStylesheets = new Set();
    const sources = new Set();

    for (const f of layoutFiles) {
        const content = readFileSafe(f);
        if (!content) continue;
        let matched = false;
        for (const m of content.matchAll(/https:\/\/fonts\.googleapis\.com\/[^\s"'<>]+/g)) {
            googleFonts.add(m[0]); matched = true;
        }
        for (const m of content.matchAll(/<link[^>]*\bhref=["'](https?:\/\/[^"']+\.css[^"']*)["'][^>]*\brel=["']stylesheet["']/gi)) {
            if (!m[1].includes('fonts.googleapis.com')) { externalStylesheets.add(m[1]); matched = true; }
        }
        for (const m of content.matchAll(/<link[^>]*\brel=["']stylesheet["'][^>]*\bhref=["'](https?:\/\/[^"']+)["']/gi)) {
            if (!m[1].includes('fonts.googleapis.com')) { externalStylesheets.add(m[1]); matched = true; }
        }
        if (matched) sources.add(path.relative(cwd, f));
    }

    return {
        googleFonts: Array.from(googleFonts),
        externalStylesheets: Array.from(externalStylesheets),
        sources: Array.from(sources),
    };
}

// ─── Framework CDN URLs ──────────────────────────────────────────────────────

function frameworkCdn(framework, version) {
    if (!framework) return null;
    if (framework.includes('tailwind')) return 'https://cdn.tailwindcss.com';
    const cleanVersion = (version || '').replace(/^[\^~]/, '');
    if (framework.includes('webpixels')) {
        const v = cleanVersion || 'latest';
        return `https://cdn.jsdelivr.net/npm/@webpixels/css@${v}/dist/index.css`;
    }
    if (framework.includes('bootstrap')) {
        const v = cleanVersion || '5.3.2';
        return `https://cdn.jsdelivr.net/npm/bootstrap@${v}/dist/css/bootstrap.min.css`;
    }
    if (framework.includes('bulma')) {
        const v = cleanVersion || '0.9.4';
        return `https://cdn.jsdelivr.net/npm/bulma@${v}/css/bulma.min.css`;
    }
    if (framework.includes('foundation')) {
        const v = cleanVersion || '6.7.5';
        return `https://cdn.jsdelivr.net/npm/foundation-sites@${v}/dist/css/foundation.min.css`;
    }
    return null;
}

// ─── CSS variable overrides (Bootstrap 5 --bs-* etc.) ────────────────────────

function buildCssVarOverrides(framework, version, scssVars) {
    const overrides = {};
    if (framework && framework.includes('bootstrap')) {
        const major = parseInt((version || '5').replace(/^[\^~]/, '').split('.')[0] || '5', 10);
        if (major >= 5) {
            const map = {
                primary: '--bs-primary', secondary: '--bs-secondary',
                success: '--bs-success', danger: '--bs-danger',
                warning: '--bs-warning', info: '--bs-info',
                'body-color': '--bs-body-color',
            };
            for (const [scss, css] of Object.entries(map)) {
                if (scssVars[scss]) overrides[css] = scssVars[scss];
            }
        }
    }
    return overrides;
}

// ─── Main ────────────────────────────────────────────────────────────────────

// Stamp the running skills version + this file's content hash to stderr, so a
// debug bundle reveals exactly which code ran (vendored copies of the skills can
// drift behind a release). Hash is authoritative.
function logSkillsVersion() {
    const p = require('path'), f = require('fs');
    const here = p.dirname(f.realpathSync(__filename));
    let version = 'unknown';
    for (const c of [p.join(here, '..', '..', 'VERSION'), p.join(here, '..', 'VERSION')]) {
        try { const v = f.readFileSync(c, 'utf8').trim(); if (v) { version = v; break; } } catch { /* next */ }
    }
    let sha = '?';
    try { sha = require('crypto').createHash('sha256').update(f.readFileSync(f.realpathSync(__filename))).digest('hex').slice(0, 8); } catch { /* ignore */ }
    console.error(`rtfm-skills detect_static.js — v${version} (sha ${sha})`);
}

function main() {
    logSkillsVersion();
    const outputDir = process.argv[2];
    const cwd = process.argv[3];
    if (!outputDir || !cwd) {
        console.error('Usage: detect_branding.js <output_dir> <cwd_to_scan>');
        process.exit(1);
    }
    if (!dirExists(cwd)) {
        console.error(`cwd_to_scan does not exist: ${cwd}`);
        process.exit(1);
    }
    if (!dirExists(outputDir)) {
        try { fs.mkdirSync(outputDir, { recursive: true }); }
        catch (err) { console.error(`Could not create ${outputDir}: ${err.message}`); process.exit(1); }
    }

    const { framework, version } = detectFrameworks(cwd);
    const compiled = findCompiledCss(cwd);
    const { rootCss, darkCss, rootSource } = extractRootBlocks(cwd);
    const scssEntry = extractScssEntry(cwd);
    const tailwindEntry = extractTailwindEntry(cwd);
    const { vars: scssVars, sources: scssSources } = extractScssVars(cwd);
    const { extend: tailwindExtend, source: twSource } = extractTailwindExtend(cwd);
    const { colors: defaultColors, sources: defaultSources, dynamic_sources: brandingSources } = extractDefaultBrandColors(cwd);
    const { googleFonts, externalStylesheets, sources: layoutSources } = extractStylesheets(cwd);

    let compiledCssPath = null;
    if (compiled && compiled.size <= MAX_COMPILED_CSS_BYTES) {
        try {
            fs.copyFileSync(compiled.path, path.join(outputDir, 'branding.css'));
            compiledCssPath = 'branding.css';
        } catch (err) {
            console.warn(`Failed to copy compiled CSS: ${err.message}`);
        }
    }

    const cdn = frameworkCdn(framework, version);
    const cssVarOverrides = buildCssVarOverrides(framework, version, scssVars);

    const branding = {};
    if (framework && framework !== 'none') branding.framework = framework;
    if (version) branding.framework_version = version;
    if (cdn) branding.framework_cdn = cdn;
    if (compiledCssPath) branding.compiled_css_path = compiledCssPath;
    if (compiled) branding.compiled_css_source = path.relative(cwd, compiled.path);
    if (scssEntry) branding.scss_entry = scssEntry;
    if (tailwindEntry) branding.tailwind_entry = tailwindEntry;
    if (rootCss) branding.root_css = rootCss;
    if (darkCss) branding.dark_css = darkCss;
    if (googleFonts.length) branding.google_fonts = googleFonts;
    if (externalStylesheets.length) branding.external_stylesheets = externalStylesheets;
    if (Object.keys(defaultColors).length) branding.default_colors = defaultColors;
    if (brandingSources && brandingSources.length) branding.branding_sources = brandingSources;
    if (tailwindExtend) branding.tailwind_extend_raw = tailwindExtend;
    if (Object.keys(cssVarOverrides).length) branding.css_var_overrides = cssVarOverrides;
    if (Object.keys(scssVars).length) branding.scss_vars = scssVars;

    const sources = [];
    if (compiled) sources.push(path.relative(cwd, compiled.path));
    if (rootSource) sources.push(rootSource);
    if (twSource) sources.push(twSource);
    for (const s of scssSources) sources.push(s);
    for (const s of defaultSources) sources.push(s);
    for (const s of layoutSources) sources.push(s);
    if (sources.length) branding.sources = Array.from(new Set(sources));

    fs.writeFileSync(path.join(outputDir, 'branding.json'), JSON.stringify(branding, null, 2));

    const summary = [`framework=${branding.framework || 'none'}`];
    if (compiledCssPath) summary.push(`compiled-css=${Math.round(compiled.size / 1024)}KB`);
    if (rootCss) summary.push('root-vars');
    if (Object.keys(defaultColors).length) summary.push(`defaults=[${Object.entries(defaultColors).map(([k, v]) => k + ':' + v).join(',')}]`);
    if (googleFonts.length) summary.push(`fonts=${googleFonts.length}`);
    console.log(`Branding detected: ${summary.join(', ')}`);
}

main();
