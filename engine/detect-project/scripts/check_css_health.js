#!/usr/bin/env node
/**
 * check_css_health.js — deterministic gate that a freshly-assembled branding.css
 * actually STYLES the project, not merely that it is large and syntactically valid.
 *
 * Motivation (a WordPress admin article): a hand-assembled bundle mirrored
 * wp-admin.css's @import list and missed the separately-enqueued login.css and
 * buttons.css, and its compiled colour-scheme section consumed
 * var(--wp-admin-theme-color) 131x with zero definitions. The result passed every
 * existing gate (valid CSS, 467KB, real selectors) and rendered the login mockup
 * as bare HTML with invisible white-on-white primary buttons. Neither failure is
 * WordPress-specific: any project that loads stylesheets per page/surface, or
 * whose theme variables are emitted by a build step, can lose them the same way.
 *
 * Three checks, all framework-agnostic:
 *
 *  1. Undefined custom properties — every `var(--x)` consumed WITHOUT a fallback
 *     must be defined somewhere in the CSS. An undefined var invalidates its whole
 *     declaration at computed-value time (background: var(--theme) paints nothing
 *     while a sibling color: #fff still applies — the invisible-button failure).
 *     Usages WITH a fallback are fine (the fallback paints).
 *
 *  2. View selector coverage — class/id tokens sampled from the project's real
 *     view/template files (route_index primary views, layouts, app_shell from
 *     project_map.json, or explicit file args) must mostly resolve to selectors
 *     in the CSS. A documented surface whose tokens are largely unmatched means
 *     the stylesheet that styles it was never bundled.
 *
 *  3. Root offset classes — a rule like `html.wp-toolbar { padding-top: … }` is
 *     the compiled-CSS fingerprint of a fixed top toolbar whose offset hangs on a
 *     root state class. When the map records a persistent app_shell but
 *     app_shell.root_classes omits every such class, every downstream mockup
 *     inherits the defect mechanically (the authoring contract copies
 *     root_classes verbatim and the fidelity lint can only enforce recorded
 *     tokens) — the fixed bar paints OVER the sidebar/content. Observed: a
 *     detect run recorded root_classes.html: [] on WordPress while its own
 *     bundle carried html.wp-toolbar { padding-top: var(…) }; the generated
 *     admin screenshots rendered the admin bar overlapping the menu. The CSS is
 *     ground truth the detecting model cannot skip. Trivial offsets (0–2px
 *     hacks like body.iframe { padding-top: 1px }) don't qualify. ERROR when
 *     the corresponding root_classes list is empty/absent; WARN when it is
 *     non-empty but missing a qualifying class (a deliberate judgment call —
 *     verify the class doesn't apply to the default authenticated page).
 *
 * Usage:
 *   node check_css_health.js <branding.css> [view files…] \
 *     [--project-map <project_map.json>] [--project-dir <dir>] \
 *     [--soft] [--json <report.json>]
 *
 * Exit codes: 0 healthy (or --soft), 1 gate failed, 2 usage error.
 * Node builtins only — no dependencies (detect-project has no package.json deps).
 */

const fs = require('fs');
const path = require('path');

// ─── Coverage thresholds ─────────────────────────────────────────────────────
// A view participates in the gate only when it declares enough distinct tokens
// to be meaningful. CSS-in-JS / hashed-class projects extract few or no literal
// tokens and are skipped rather than false-failed.
const MIN_TOKENS_FOR_GATE = 8;
const FAIL_RATIO = 0.5;
const WARN_RATIO = 0.75;
const MAX_VIEWS = 12;
const MAX_VIEW_BYTES = 512 * 1024;
// Undefined vars: 1–2 stray no-fallback usages may be an intentional optional
// hook; 3+ means a consumed theme/scheme file is missing its definitions.
const VAR_ERROR_MIN_USES = 3;

const MARKUP_EXTENSIONS = new Set([
    '.html', '.htm', '.xhtml', '.erb', '.rhtml', '.haml', '.slim',
    '.php', '.phtml', '.twig', '.blade.php',
    '.heex', '.leex', '.eex', '.ex',
    '.tsx', '.jsx', '.js', '.mjs', '.vue', '.svelte', '.astro',
    '.ejs', '.hbs', '.handlebars', '.mustache', '.njk', '.liquid',
    '.cshtml', '.razor', '.pug', '.jade',
]);

function stripCssNoise(css) {
    return css
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/url\(\s*(?:'[^']*'|"[^"]*"|[^)]*)\)/gi, 'url()');
}

// ─── Check 3: root offset classes ────────────────────────────────────────────
// A padding-top value counts as a real chrome offset unless it is a reset/hack:
// 0, 1–2px, or a non-length keyword. var()/rem/em/≥3px all qualify.
function isTrivialOffset(value) {
    const v = value.replace(/!important/gi, '').trim().toLowerCase();
    if (['initial', 'unset', 'inherit', 'revert', 'auto', ''].includes(v)) return true;
    return /^0(\.0+)?(px|rem|em|%|vh|vw)?$/.test(v) || /^[12](\.\d+)?px$/.test(v);
}

// Scan innermost CSS rules (the regex naturally skips at-rule wrappers) for
// html.<class> / body.<class> selectors whose declarations set a non-trivial
// padding-top. Returns { html: Set<class>, body: Set<class> }.
function findRootOffsetClasses(css) {
    const found = { html: new Set(), body: new Set() };
    for (const m of css.matchAll(/([^{};]+)\{([^{}]*)\}/g)) {
        const [, selector, decls] = m;
        const pt = decls.match(/(?:^|;)\s*padding-top\s*:\s*([^;]+)/i);
        if (!pt || isTrivialOffset(pt[1])) continue;
        for (const sm of selector.matchAll(/(?:^|[,\s])(html|body)\.([A-Za-z0-9_-]+)/g)) {
            found[sm[1]].add(sm[2]);
        }
    }
    return found;
}

function analyzeRootOffsetClasses(css, projectMap) {
    const out = { errors: [], warnings: [], candidates: { html: [], body: [] } };
    const shell = projectMap && projectMap.app_shell;
    if (!shell || typeof shell !== 'object') return out;  // no persistent shell — nothing to offset
    const offsets = findRootOffsetClasses(css);
    const rc = shell.root_classes || {};
    for (const root of ['html', 'body']) {
        const candidates = [...offsets[root]].sort();
        out.candidates[root] = candidates;
        if (!candidates.length) continue;
        const recorded = new Set(Array.isArray(rc[root]) ? rc[root] : []);
        const missing = candidates.filter(c => !recorded.has(c));
        if (!missing.length) continue;
        const msg = `branding.css scopes a fixed-chrome offset to ${root}.` +
            `${missing.join(` / ${root}.`)} (padding-top rule) but app_shell.root_classes.${root} ` +
            `${recorded.size ? `records [${[...recorded].join(', ')}] without it` : 'is empty'} — ` +
            `if the default authenticated page carries the class, mockups without it render the ` +
            `fixed bar OVER the content`;
        if (recorded.size) out.warnings.push(msg);
        else out.errors.push(msg);
    }
    return out;
}

// ─── Check 1: custom properties ──────────────────────────────────────────────
function analyzeCustomProperties(css) {
    const defined = new Set();
    for (const m of css.matchAll(/(?:^|[{;\s])(--[A-Za-z0-9_-]+)\s*:/g)) defined.add(m[1]);
    for (const m of css.matchAll(/@property\s+(--[A-Za-z0-9_-]+)/g)) defined.add(m[1]);

    // Count var(--x) only inside CONCRETE declarations (property not itself a
    // custom prop). A var() inside another custom property's value resolves
    // lazily and is often intentionally undefined — Tailwind v3's
    // `--tw-shadow-colored: … var(--tw-shadow-color)` idiom would otherwise
    // false-fail every v3 project. var(--x, …) with a fallback is always fine.
    const noFallback = new Map();
    const withFallback = new Map();
    for (const d of css.matchAll(/(?:^|[{;])\s*([A-Za-z-][A-Za-z0-9_-]*)\s*:\s*([^;{}]*)/g)) {
        if (d[1].startsWith('--')) continue;
        for (const m of d[2].matchAll(/var\(\s*(--[A-Za-z0-9_-]+)\s*([,)])/g)) {
            const bucket = m[2] === ')' ? noFallback : withFallback;
            bucket.set(m[1], (bucket.get(m[1]) || 0) + 1);
        }
    }

    const errors = [];
    const warnings = [];
    for (const [name, uses] of [...noFallback.entries()].sort((a, b) => b[1] - a[1])) {
        if (defined.has(name)) continue;
        const msg = `var(${name}) used ${uses}x without a fallback but never defined — ` +
            `every declaration consuming it is invalid at computed-value time`;
        if (uses >= VAR_ERROR_MIN_USES) errors.push(msg);
        else warnings.push(msg);
    }
    return { defined, errors, warnings };
}

// ─── Check 2: view selector coverage ─────────────────────────────────────────
// One scan of the CSS builds the sets of class/id names that appear in selector
// position (Tailwind's escaped selectors like `.lg\:grid-cols-3` are unescaped).
// Number/hex noise from declarations ("1.5s" → "5s", "#fff") is harmless: no
// real template token looks like it.
function buildSelectorSets(css) {
    const classes = new Set();
    const ids = new Set();
    for (const m of css.matchAll(/\.((?:[A-Za-z0-9_-]|\\[^\s])+)/g)) {
        classes.add(m[1].replace(/\\(.)/g, '$1'));
    }
    for (const m of css.matchAll(/#((?:[A-Za-z0-9_-]|\\[^\s])+)/g)) {
        ids.add(m[1].replace(/\\(.)/g, '$1'));
    }
    return { classes, ids };
}

function stripTemplateInterpolation(value) {
    return value
        .replace(/<%[\s\S]*?%>/g, ' ')      // ERB
        .replace(/<\?(?:php)?[\s\S]*?(?:\?>|$)/g, ' ') // PHP
        .replace(/\{\{[\s\S]*?\}\}/g, ' ')  // mustache/vue/liquid
        .replace(/\{%[\s\S]*?%\}/g, ' ')    // twig/liquid tags
        .replace(/\$\{[\s\S]*?\}/g, ' ')    // JS template literal
        .replace(/#\{[\s\S]*?\}/g, ' ');    // ruby/haml
}

function collectTokens(value, into) {
    for (const raw of stripTemplateInterpolation(value).split(/\s+/)) {
        const t = raw.trim();
        if (!t || t.length > 64) continue;
        if (/[<>="'`;{}]/.test(t)) continue;          // interpolation shrapnel
        if (/[-:(]$/.test(t)) continue;                // truncated by stripped interp
        if (!/^-?[A-Za-z_]/.test(t)) continue;         // classes start with a letter/_/-
        into.add(t);
    }
}

function extractViewTokens(text) {
    const classes = new Set();
    const ids = new Set();
    for (const m of text.matchAll(/\bclass(?:Name)?\s*=\s*(["'])([\s\S]*?)\1/g)) {
        collectTokens(m[2], classes);
    }
    // className={clsx('a', cond && 'b')} — string literals inside the braces
    for (const m of text.matchAll(/\bclassName\s*=\s*\{([^}]*)\}/g)) {
        for (const s of m[1].matchAll(/(["'`])([^"'`]*)\1/g)) collectTokens(s[2], classes);
    }
    for (const m of text.matchAll(/\bid\s*=\s*(["'])([^"']*)\1/g)) {
        const t = stripTemplateInterpolation(m[2]).trim();
        if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(t)) ids.add(t);
    }
    return { classes, ids };
}

function coverageForView(viewPath, text, selectorSets) {
    const { classes, ids } = extractViewTokens(text);
    const unmatched = [];
    let matched = 0;
    for (const c of classes) {
        if (selectorSets.classes.has(c)) matched++;
        else unmatched.push('.' + c);
    }
    for (const i of ids) {
        if (selectorSets.ids.has(i)) matched++;
        else unmatched.push('#' + i);
    }
    const total = classes.size + ids.size;
    return { view: viewPath, total, matched, unmatched };
}

// ─── View sampling from project_map.json ─────────────────────────────────────
function looksLikeMarkupFile(p) {
    if (typeof p !== 'string' || !p || p.startsWith('http')) return false;
    const lower = p.toLowerCase();
    if (lower.endsWith('.blade.php')) return true;
    return MARKUP_EXTENSIONS.has(path.extname(lower));
}

function collectViewsFromMap(pm, projectDir) {
    const candidates = [];
    const push = (p) => { if (looksLikeMarkupFile(p)) candidates.push(p); };

    const routeIndex = pm.route_index || {};
    for (const entry of Object.values(routeIndex)) {
        if (!entry || typeof entry !== 'object') continue;
        push(entry.primary_view);
        push(entry.view);
        push(entry.definition_file);
        push(entry.entry);
    }
    for (const layout of pm.layouts || []) {
        push(typeof layout === 'string' ? layout : layout && layout.path);
    }
    for (const chrome of pm.global_chrome || []) {
        push(typeof chrome === 'string' ? chrome : chrome && chrome.path);
    }
    if (pm.app_shell && typeof pm.app_shell === 'object') {
        push(pm.app_shell.definition_file);
    }

    const seen = new Set();
    const out = [];
    for (const rel of candidates) {
        if (seen.has(rel)) continue;
        seen.add(rel);
        const abs = path.isAbsolute(rel) ? rel : path.join(projectDir, rel);
        try {
            const st = fs.statSync(abs);
            if (st.isFile() && st.size <= MAX_VIEW_BYTES) out.push({ rel, abs });
        } catch { /* listed but missing — skip */ }
        if (out.length >= MAX_VIEWS) break;
    }
    return out;
}

// ─── Main ────────────────────────────────────────────────────────────────────
function main() {
    const args = process.argv.slice(2);
    let cssPath = null;
    let projectMapPath = null;
    let projectDir = process.cwd();
    let soft = false;
    let jsonOut = null;
    const explicitViews = [];

    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--project-map') projectMapPath = args[++i];
        else if (a === '--project-dir') projectDir = args[++i];
        else if (a === '--soft') soft = true;
        else if (a === '--json') jsonOut = args[++i];
        else if (!cssPath) cssPath = a;
        else explicitViews.push(a);
    }

    if (!cssPath || !fs.existsSync(cssPath)) {
        console.error('Usage: check_css_health.js <branding.css> [view files…] ' +
            '[--project-map <project_map.json>] [--project-dir <dir>] [--soft] [--json <out>]');
        process.exit(2);
    }

    const css = stripCssNoise(fs.readFileSync(cssPath, 'utf8'));

    // Check 1 — custom properties
    const vars = analyzeCustomProperties(css);
    console.log('== CSS health: custom properties ==');
    if (!vars.errors.length && !vars.warnings.length) {
        console.log('[ OK ] every var(--x) consumed without a fallback is defined');
    }
    for (const e of vars.errors) console.log(`[FAIL] ERROR: ${e}`);
    for (const w of vars.warnings) console.log(`[WARN] WARN:  ${w}`);

    // Check 2 — view selector coverage
    let pm = null;
    let views = explicitViews
        .map(rel => ({ rel, abs: path.isAbsolute(rel) ? rel : path.join(projectDir, rel) }))
        .filter(v => fs.existsSync(v.abs));
    if (projectMapPath && fs.existsSync(projectMapPath)) {
        try {
            pm = JSON.parse(fs.readFileSync(projectMapPath, 'utf8'));
            const sampled = collectViewsFromMap(pm, projectDir);
            const have = new Set(views.map(v => v.rel));
            for (const v of sampled) if (!have.has(v.rel)) views.push(v);
        } catch (e) {
            console.log(`[WARN] WARN:  could not parse project map ${projectMapPath}: ${e.message}`);
        }
    }
    views = views.slice(0, MAX_VIEWS);

    console.log('== CSS health: view selector coverage ==');
    const results = [];
    if (!views.length) {
        console.log('[SKIP] no view/template files to probe (empty route_index/layouts and no view args) — coverage not verified');
    }
    const selectorSets = buildSelectorSets(css);
    let coverageErrors = 0;
    for (const v of views) {
        const text = fs.readFileSync(v.abs, 'utf8');
        const r = coverageForView(v.rel, text, selectorSets);
        results.push(r);
        const pct = r.total ? Math.round((r.matched / r.total) * 100) : 100;
        const sample = r.unmatched.slice(0, 8).join(', ') + (r.unmatched.length > 8 ? ', …' : '');
        if (r.total < MIN_TOKENS_FOR_GATE) {
            console.log(`[SKIP] ${r.view}: only ${r.total} class/id token(s) extracted — too few to judge`);
        } else if (r.matched / r.total < FAIL_RATIO) {
            coverageErrors++;
            console.log(`[FAIL] ${r.view}: ${r.matched}/${r.total} tokens styled (${pct}%) — unmatched: ${sample}`);
        } else if (r.matched / r.total < WARN_RATIO) {
            console.log(`[WARN] ${r.view}: ${r.matched}/${r.total} tokens styled (${pct}%) — unmatched: ${sample}`);
        } else {
            console.log(`[ OK ] ${r.view}: ${r.matched}/${r.total} tokens styled (${pct}%)`);
        }
    }

    // Check 3 — root offset classes (needs the map's app_shell; skips without it)
    console.log('== CSS health: root offset classes ==');
    const rootOffsets = analyzeRootOffsetClasses(css, pm);
    if (!pm || !pm.app_shell) {
        console.log('[SKIP] no project map / app_shell — root offset classes not verified');
    } else if (!rootOffsets.errors.length && !rootOffsets.warnings.length) {
        const n = rootOffsets.candidates.html.length + rootOffsets.candidates.body.length;
        console.log(n
            ? `[ OK ] every root-scoped offset class is recorded in app_shell.root_classes (${n} candidate(s))`
            : '[ OK ] no root-scoped fixed-chrome offset rules in branding.css');
    }
    for (const e of rootOffsets.errors) console.log(`[FAIL] ERROR: ${e}`);
    for (const w of rootOffsets.warnings) console.log(`[WARN] WARN:  ${w}`);

    const failed = vars.errors.length > 0 || coverageErrors > 0 || rootOffsets.errors.length > 0;
    if (jsonOut) {
        fs.writeFileSync(jsonOut, JSON.stringify({
            css: cssPath,
            undefined_vars: { errors: vars.errors, warnings: vars.warnings },
            views: results,
            root_offset_classes: rootOffsets,
            failed,
            soft,
        }, null, 2));
    }

    if (failed) {
        console.log('');
        console.log('STOP: CSS HEALTH GATE FAILED — branding.css does not fully style this project.');
        console.log('Repair the bundle, then re-run this check until it passes:');
        console.log('- [FAIL] coverage view(s): the project loads stylesheets per page/surface. Find the');
        console.log('  stylesheet(s) THOSE views actually load — their <link>/enqueue/import wiring, not');
        console.log('  the main bundle\'s import list — and append them to branding.css.');
        console.log('- undefined vars: append the theme/scheme/tokens stylesheet that defines them (often');
        console.log('  a build-emitted file), or define them in a :root block with the real detected values.');
        console.log('- root offset classes: the CSS proves a fixed-chrome offset hangs on a root state class');
        console.log('  the map does not record. Chase the root-class emission (the layout, or the helper it');
        console.log('  calls) and record the resolved DEFAULT-user tokens in app_shell.root_classes, then');
        console.log('  re-run this check. This is a project_map.json repair, not a CSS repair.');
        console.log('- re-run sanitize_css.js after appending CSS, then re-run this check.');
        if (soft) {
            console.log('(soft mode: fallback_synthesis is the known-degraded floor — reporting only, not failing)');
            process.exit(0);
        }
        process.exit(1);
    }
    console.log('\nCSS health gate passed.');
    process.exit(0);
}

main();
