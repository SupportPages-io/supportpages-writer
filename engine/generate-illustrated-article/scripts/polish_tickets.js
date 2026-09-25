#!/usr/bin/env node
/**
 * polish_tickets.js — deterministic "where to look" tickets for the POLISH phase
 * of generate-illustrated-article (Phase 4), and the matching --report.
 *
 * The model never looks at its own render. Every input-side gate (the fidelity
 * lint, the copy lint) reads text, and a mockup can pass all of them while the
 * PNG is missing whole regions: a sidebar copied faithfully from source with a
 * `hidden lg:flex` class pair scores 4/4 shell labels and paints 0 px at the
 * capture width. This script turns the structured signals nobody consumes —
 * lint_report.json metrics, block diagnostics (render score, evidence and probe
 * visibility), the project map's app_shell / layouts[].chrome, and the block's
 * own source files — into per-block QUESTIONS that tell the model where to look
 * in the PNG and which files to compare against. Tickets are where to look,
 * never text to transcribe: the model answers each question against the PNG
 * and the sources and repairs by ADDING what is missing.
 *
 * Usage:
 *   polish_tickets.js <article_dir> [project_root]            → <article_dir>/polish_tickets.json
 *   polish_tickets.js <article_dir> [project_root] --restore  → …and copy each ticketed block's
 *                                                               .html.pre (raw authored HTML) back
 *                                                               over its injected .html for editing
 *   polish_tickets.js <article_dir> [project_root] --report   → <article_dir>/polish_report.json
 *
 * Always exits 0 and writes ONLY its own output file (plus the --restore
 * copies, which only ever put the model's own authored HTML back). Missing or
 * unparsable inputs degrade to fewer questions, never to a failure — the phase
 * is additive and must not be able to break the pipeline.
 *
 * Gate (script-side, like watermark.js): RTFM_POLISH in off/0/false/no writes
 * {"enabled": false} and prints `polish: disabled`. Caps: RTFM_POLISH_MAX_EDITS
 * (per block, default 6) and RTFM_POLISH_MAX_BLOCKS (0 = all).
 *
 * Every question carries a machine re-checkable `check` (or {type:"manual"});
 * --report re-evaluates them against the re-lint, the fresh diagnostics, and
 * the edited HTML, and records per block whether the HTML/PNG changed and how
 * the render score and chrome mean moved. `html_changed` (raw authored HTML
 * sha) is the "the model edited this block" signal; `png_changed` is byte-level
 * and a plain re-render is NOT always byte-identical (font/CDN timing), so it
 * only says "re-rendered", never "visibly different". The chrome mean is the
 * mean of the six chrome ratios that apply, matching the offline scorer. None of this feeds an error or an exit code.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const includeCensus = require('./include_census.js');

const SCHEMA_VERSION = 1;
const CHROME_KEYS = ['shell_nav_labels', 'chrome_files_expanded', 'runtime_ui_strings',
    'runtime_regions_rendered', 'root_classes_html', 'layout_root_classes'];
const T = {
    shell_labels: 0.8, shell_labels_blocking: 0.5,
    chrome_files: 1, runtime_strings: 0.8,
    styled_coverage: 0.6, styled_min_total: 10,
    render_score: 80,
};
const CAPS = { components: 6, labels: 12, form_fields: 12, nav: 12, read_order: 10, scan_files: 8 };
const FILE_READ_CAP = 400 * 1024;
const CONTENT_DEDUCTION_RE = /blank|few visible|cut off|geometry/i;
const LOCALE_PATH_RE = /(?:^|\/)(?:locales?|i18n|lang|translations?|messages|l10n)(?:\/|\.)/i;
const LOCALE_EXT_RE = /\.(?:json|ya?ml|arb)$/i;
// PascalCase tags that are UI primitives, not screen regions — a mockup never
// "corresponds" to a <Button>, so they never earn a component ticket.
const UI_PRIMITIVES = new Set(('Button Icon Tooltip Dialog Link Input Select Form Label Badge Avatar Skeleton Trans ' +
    'Head Meta Fragment Suspense Provider Image Img Text Box Flex Grid Stack Card Container Divider Spinner ' +
    'Loader Portal Popover Menu MenuItem DropdownMenu Checkbox Switch Radio Textarea TextField Alert Toast ' +
    'Modal Sheet Tabs Tab Table Th Td Tr Slot Transition Motion ErrorBoundary Script Layout Component Title ' +
    'Description Separator Toaster Helmet Router Routes Route Outlet NavLink Anchor Heading Paragraph Span ' +
    'Center Group Row Col Column Section Main Header Footer Nav Aside Article Wrapper Root Content Trigger ' +
    'Item List ListItem Field FormField FormItem FormLabel FormControl FormMessage Kbd Code Pre Strong Em Small').split(' '));
// Suffixes/prefixes that mark a PascalCase tag as a primitive, an icon, or a
// TypeScript type used in a generic (<Props>, <Params>) rather than a region.
const PRIMITIVE_SUFFIX_RE = /(?:Provider|Context|Boundary|Icon|Trigger|Portal|Props|Params|Button|Link)$/;
const ICON_PREFIX_RE = /^(?:Icon|Lucide|Tabler|Fa|Md|Hi|Bi|Ri|Io)[A-Z]/;
// Labels are short and un-punctuated; sentences ending in . ! ? are messages
// (errors, toasts, confirmations) that no screen shows in its default state.
const MESSAGE_LABEL_RE = /[.!?]$|^(?:sorry|error|invalid|please|you (?:are|have|need|do not|don't|can(?:not|'t))|are you sure|something went wrong|failed to|unable to)\b/i;
const MAX_LABEL_WORDS = 6;
// Paths the model sometimes lists as sources but which are never screen sources.
const NON_SOURCE_PATH_RE = /(?:^|\/)(?:\.rtfm(?:-branding)?|\.rtfm-trace|output|node_modules|\.git)\//;
// Only literal labels can be checked for presence; prose descriptions
// ("nav links: Home, Groups, …", "'Howdy, <name>' account menu") ride along
// as context for the compare question instead.
function isLiteralLabel(s) {
    const t = norm(s);
    if (t.length < 2 || t.length > 40) return false;
    if (/[():<>"'—–\[\]{}|]/.test(t)) return false;
    if (!/^[A-Z0-9]/.test(t)) return false;        // descriptions start lowercase ("updates badge with count")
    return t.split(' ').length <= 4;
}
// Overlays are hidden in a screen's default state; a block that depicts one
// names its file as primary_view, so an overlay reached through a layout or
// chrome file is never a missing region.
const OVERLAY_NAME_RE = /modal|dialog|drawer|toast|tooltip|popover|snackbar|lightbox|flash/i;
// A shell-carrying layout is one the map ties the shell to; a layout whose own
// description says it has no sidebar / is fullscreen does not grow one.
const SHELL_ABSENT_RE = /\bno (?:left |right |app |persistent )?(?:sidebar|side bar|side-bar|app shell|shell|navigation)\b|without (?:the |a )?(?:sidebar|shell)|\b(?:fullscreen|full-screen|full screen)\b|hides? the (?:app )?shell|shell(?: is)? hidden/i;

// ─── small utilities ─────────────────────────────────────────────────────────
function polishEnabled(env = process.env) {
    const v = String(env.RTFM_POLISH ?? 'on').trim().toLowerCase();
    return !(v === 'off' || v === '0' || v === 'false' || v === 'no');
}
function intEnv(name, dflt, env = process.env) {
    const n = parseInt(String(env[name] ?? ''), 10);
    return Number.isFinite(n) && n >= 0 ? n : dflt;
}
function readJson(p) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
function readText(p, cap = FILE_READ_CAP) {
    try {
        const st = fs.statSync(p);
        if (!st.isFile()) return '';
        const fd = fs.openSync(p, 'r');
        try {
            const len = Math.min(st.size, cap);
            const buf = Buffer.alloc(len);
            fs.readSync(fd, buf, 0, len, 0);
            return buf.toString('utf8');
        } finally { fs.closeSync(fd); }
    } catch { return ''; }
}
function sha256File(p) {
    try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return null; }
}
function isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }
function norm(s) { return String(s).replace(/\s+/g, ' ').trim(); }
function uniq(arr) { return [...new Set(arr)]; }
function ratioOf(m) {
    return m && typeof m === 'object' && typeof m.ratio === 'number' ? m.ratio : null;
}
function countOf(m) {
    return m && typeof m === 'object' && typeof m.count === 'number' ? m.count : null;
}
function chromeMean(metrics) {
    if (!metrics || typeof metrics !== 'object') return null;
    const vals = CHROME_KEYS.map(k => ratioOf(metrics[k])).filter(v => v !== null);
    if (!vals.length) return null;
    return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 1000) / 1000;
}
function extractVisibleText(html) {
    let s = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ');
    s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');
    s = s.replace(/<!--[\s\S]*?-->/g, ' ');
    s = s.replace(/<[^>]+>/g, ' ');
    s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
    return s.replace(/\s+/g, ' ').trim();
}
// Lower-cased tokens from id / class / data-* attribute values — the mockup's
// structural vocabulary (a region named after a component "corresponds").
function attrTokens(html) {
    const out = new Set();
    for (const m of html.matchAll(/\b(?:id|class|data-[a-z0-9-]+)\s*=\s*["']([^"']*)["']/gi)) {
        for (const tok of m[1].split(/[\s,;|]+/)) {
            const t = tok.trim().toLowerCase();
            if (t) out.add(t.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ''));
        }
    }
    return out;
}
function nameTokens(name) {
    const kebab = name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
    return uniq([name.toLowerCase(), kebab, kebab.replace(/-/g, '_'), kebab.replace(/-/g, '')]);
}
function countFormControls(html) {
    let n = 0;
    for (const m of html.matchAll(/<(input|select|textarea)\b([^>]*)>/gi)) {
        if (m[1].toLowerCase() === 'input' && /\btype\s*=\s*["']?hidden\b/i.test(m[2])) continue;
        n++;
    }
    for (const m of html.matchAll(/\brole\s*=\s*["'](combobox|switch|checkbox|radio|textbox|spinbutton|slider)["']/gi)) {
        if (m) n++;
    }
    return n;
}

// ─── inputs ──────────────────────────────────────────────────────────────────
function loadProjectMap(root) {
    for (const d of ['.rtfm', '.rtfm-branding']) {
        const pm = readJson(path.join(root, d, 'project_map.json'));
        if (pm) return pm;
    }
    return null;
}
function shellLabels(items) {
    const out = [];
    const walk = list => {
        for (const it of Array.isArray(list) ? list : []) {
            if (!it) continue;
            const label = typeof it === 'string' ? it : it.label;
            if (typeof label === 'string' && label.trim().length >= 3) out.push(label.trim());
            if (it && Array.isArray(it.children)) walk(it.children);
        }
    };
    walk(items);
    return uniq(out);
}
function shellSummary(pm) {
    const shell = pm && pm.app_shell;
    if (!shell || typeof shell !== 'object') return null;
    // The lint's shell_nav_labels metric uses TOP-LEVEL nav labels only; the
    // probe and the tickets look one level deeper too, but the metric-mirroring
    // list must match the lint so a ticket names the labels the metric counted.
    const topLevel = (shell.nav_items || []).map(n => n && n.label)
        .filter(l => typeof l === 'string' && l.length >= 3);
    const topBar = shell.top_bar && typeof shell.top_bar === 'object' ? shell.top_bar : null;
    return {
        type: shell.type || null,
        layout: shell.layout || null,
        nav_labels: topLevel,
        nav_labels_all: shellLabels(shell.nav_items),
        footer_labels: shellLabels(shell.footer_items),
        account_area: typeof shell.account_area === 'string' ? shell.account_area
            : (shell.account_area ? JSON.stringify(shell.account_area) : null),
        top_bar: topBar ? {
            items_left: shellLabels(topBar.items_left), items_right: shellLabels(topBar.items_right),
        } : null,
        notes: typeof shell.notes === 'string' ? shell.notes : null,
    };
}
function layoutFor(pm, ref) {
    if (!pm || !ref || !Array.isArray(pm.layouts)) return null;
    const want = String(ref).trim();
    const hit = pm.layouts.find(l => l && (l.name === want || l.path === want))
        || pm.layouts.find(l => l && typeof l.path === 'string' && (l.path.endsWith('/' + want) || want.endsWith('/' + l.path)));
    if (!hit) return null;
    return {
        name: hit.name || null,
        path: typeof hit.path === 'string' ? hit.path : null,
        chrome: Array.isArray(hit.chrome) ? hit.chrome.filter(c => typeof c === 'string') : null,
        runtime_chrome: hit.runtime_chrome && typeof hit.runtime_chrome === 'object' ? hit.runtime_chrome : null,
        root_classes: hit.root_classes || null,
        area: typeof hit.area === 'string' ? hit.area : null,
    };
}
function blockEntries(vs) {
    const raw = (vs && (vs.blocks || vs.steps)) || [];
    return raw.map((entry, position) => {
        if (!entry || typeof entry !== 'object') return null;
        const legacy = entry.block_id === undefined;
        const key = legacy ? String(entry.index ?? position) : String(entry.block_id);
        const base = legacy ? `step_${key}` : `block_${key}`;
        return {
            key, legacy, position,
            block_id: legacy ? null : String(entry.block_id),
            index: Number.isInteger(entry.index) ? entry.index : position,
            base,
            html: `${base}.html`, pre: `${base}.html.pre`, png: `${base}.png`,
            diagnostics: `${base}_diagnostics.json`,
            entry,
        };
    }).filter(Boolean);
}
function lintEntryFor(lint, block) {
    const list = (lint && (lint.blocks || lint.steps)) || [];
    return list.find(e => e && (block.block_id !== null
        ? String(e.block_id) === block.block_id
        : Number(e.index) === Number(block.index))) || null;
}
function evidenceStrings(entry) {
    return (entry.verbatim_evidence || [])
        .map(e => (typeof e === 'string' ? e : (e && e.string) || ''))
        .map(norm).filter(Boolean);
}
function absenceStrings(entry) {
    const out = [];
    for (const a of Array.isArray(entry.default_user_assumptions) ? entry.default_user_assumptions : []) {
        for (const s of (a && a.markup_absence_check) || []) if (typeof s === 'string') out.push(s.toLowerCase());
    }
    return out;
}
function actionTargetsFor(vs, block) {
    const keys = new Set([block.key]);
    if (block.block_id !== null) keys.add(String(block.index));
    const out = [];
    for (const e of Array.isArray(vs && vs.action_coverage) ? vs.action_coverage : []) {
        if (!e) continue;
        const k = e.screenshot_block_id ?? e.screenshot_step_index;
        if (k !== undefined && keys.has(String(k)) && typeof e.target === 'string' && e.target.trim()) {
            out.push({ target: norm(e.target), kind: e.kind || null });
        }
    }
    return out;
}

// ─── source scanners (generic, regex-only, bounded) ─────────────────────────
const TEMPLATE_NOISE_RE = /[{}<>]|<%|\$\{|#\{|%}|=>|\bt\(|\bI18n\b|__\(|\bthis\.|\bprops\.|\bstate\./;
function cleanLabel(s) {
    let t = String(s).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
    if (t.length < 3 || t.length > 60) return null;
    if (TEMPLATE_NOISE_RE.test(t)) return null;
    if (!/[A-Za-z]/.test(t)) return null;
    if (/^[a-z][A-Za-z0-9_]*$/.test(t) && /[A-Z_]/.test(t)) return null;   // identifier, not copy
    if (/^[\w.-]+\.[\w.-]+$/.test(t)) return null;                          // dotted key / filename
    if (/%\d*\$?[sd]|&#|\\"|\{\{|\}\}|\$\w/.test(t)) return null;           // printf / entity / mustache / $var placeholders
    return t;
}
function isScreenLabel(s) {
    return !MESSAGE_LABEL_RE.test(s) && s.split(' ').length <= MAX_LABEL_WORDS;
}
// opts.nav: also harvest link text and label:/title: object literals (layout and
// chrome files). opts.visibleOnly: drop aria-label/title/alt — attributes that
// never paint, so their absence is not something a PNG comparison can show.
function extractLabels(text, opts = {}) {
    const out = [];
    const push = s => { const c = cleanLabel(s); if (c) out.push(c); };
    for (const m of text.matchAll(/<(label|button|th|h1|h2|h3|legend|summary|option)\b[^>]*>([\s\S]{0,400}?)<\/\1>/gi)) push(m[2]);
    // Text children of components: <Button>Save</Button>, <Trans>…</Trans>, <Badge>New</Badge>.
    for (const m of text.matchAll(/<([A-Z][A-Za-z0-9.]*)\b[^>]*>([^<{}]{3,60})<\/\1>/g)) push(m[2]);
    for (const m of text.matchAll(/\bplaceholder\s*=\s*["']([^"'{}<>]{3,60})["']/gi)) push(m[1]);
    if (!opts.visibleOnly) {
        for (const m of text.matchAll(/\b(?:aria-label|title|alt)\s*=\s*["']([^"'{}<>]{3,60})["']/gi)) push(m[1]);
    }
    for (const m of text.matchAll(/\b(?:__|_e|esc_html__|esc_html_e|esc_attr__|esc_attr_e|_x|gettext|dgettext|ngettext)\(\s*['"]([^'"]{3,60})['"]/g)) push(m[1]);
    // Rails helpers: link_to "Home", button_to "Save", f.submit "Create", f.label :x, "Label", submit_tag "Go".
    for (const m of text.matchAll(/\b(?:link_to|button_to|submit_tag|button_tag|label_tag)\s*\(?\s*["']([^"'{}<>#]{3,60})["']/g)) push(m[1]);
    for (const m of text.matchAll(/\b\w+\.(?:submit|button|label)\s*\(?\s*(?::\w+\s*,\s*)?["']([^"'{}<>#]{3,60})["']/g)) push(m[1]);
    if (opts.nav) {
        for (const m of text.matchAll(/<a\b[^>]*>([\s\S]{0,300}?)<\/a>/gi)) push(m[1]);
        for (const m of text.matchAll(/\b(?:label|title|name|text)\s*:\s*["']([^"'{}<>]{3,60})["']/g)) push(m[1]);
    }
    return uniq(out);
}
function extractI18nKeys(text) {
    const keys = [];
    for (const re of [
        /(?:^|[^\w$.])t\(\s*['"`]([\w.:-]+)['"`]/g,
        /\{\{\s*\$?t\s*\(\s*['"]([\w.:-]+)['"]/g,
        /\bI18n\.t\(\s*['"]([\w.:-]+)['"]/g,
        /\$t\(\s*['"]([\w.:-]+)['"]/g,
        /\btranslate\(\s*['"]([\w.:-]+)['"]/g,
    ]) for (const m of text.matchAll(re)) keys.push(m[1]);
    return uniq(keys);
}
// Minimal locale index: JSON (nested → dotted keys) and simple indented YAML
// (`key: value` / `key:` lines). Enough for common.json / en.yml lookups; a key
// the index cannot resolve is simply not a candidate.
class LocaleIndex {
    constructor() { this.map = new Map(); this.files = []; }
    addJson(text, file) {
        let obj; try { obj = JSON.parse(text); } catch { return; }
        this.files.push(file);
        const walk = (node, prefix) => {
            if (node && typeof node === 'object' && !Array.isArray(node)) {
                for (const [k, v] of Object.entries(node)) walk(v, prefix ? `${prefix}.${k}` : k);
            } else if (typeof node === 'string') this.map.set(prefix, node);
        };
        walk(obj, '');
    }
    addYaml(text, file) {
        this.files.push(file);
        const stack = [];   // [{indent, key}]
        for (const raw of text.split(/\r?\n/)) {
            if (!raw.trim() || /^\s*#/.test(raw)) continue;
            const m = raw.match(/^(\s*)([\w.-]+)\s*:\s*(.*)$/);
            if (!m) continue;
            const indent = m[1].length;
            while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
            const keyPath = [...stack.map(s => s.key), m[2]].join('.');
            let val = m[3].trim();
            if (val === '' || val === '|' || val === '>') { stack.push({ indent, key: m[2] }); continue; }
            if (/^["'].*["']$/.test(val)) val = val.slice(1, -1);
            if (val.startsWith('[') || val.startsWith('{') || val.startsWith('&') || val.startsWith('*')) continue;
            this.map.set(keyPath, val);
        }
    }
    lookup(key, lazyPrefix) {
        if (!key) return null;
        const candidates = [];
        if (key.startsWith('.') && lazyPrefix) candidates.push(`${lazyPrefix}${key}`, `en.${lazyPrefix}${key}`);
        else candidates.push(key, `en.${key}`, key.replace(/:/g, '.'), `en.${key.replace(/:/g, '.')}`);
        for (const c of candidates) { const v = this.map.get(c); if (typeof v === 'string') return v; }
        // colon-namespaced keys (i18next "common:save") → try the tail alone
        const tail = key.includes(':') ? key.split(':').pop() : null;
        if (tail && this.map.has(tail)) return this.map.get(tail);
        return null;
    }
}
function isLocaleFile(rel) {
    return LOCALE_EXT_RE.test(rel) && LOCALE_PATH_RE.test(rel);
}
function buildLocaleIndex(root, partials) {
    const idx = new LocaleIndex();
    for (const rel of partials) {
        if (!isLocaleFile(rel)) continue;
        const text = readText(path.join(root, rel));
        if (!text) continue;
        if (/\.json$/i.test(rel) || /\.arb$/i.test(rel)) idx.addJson(text, rel);
        else idx.addYaml(text, rel);
    }
    return idx;
}
function lazyPrefixFor(rel) {
    // Rails lazy lookup: app/views/users/reset_password.html.erb → users.reset_password
    const m = rel.match(/(?:^|\/)app\/views\/(.+?)\.[a-z]+(?:\.[a-z]+)?$/);
    if (!m) return null;
    return m[1].split('/').map(seg => seg.replace(/^_/, '')).join('.');
}
function resolveModule(src, fromDir, root) {
    const bases = [];
    if (src.startsWith('.')) bases.push(path.resolve(fromDir, src));
    else if (src.startsWith('@/') || src.startsWith('~/')) {
        for (const pre of ['src', 'app', 'resources/js', '']) bases.push(path.join(root, pre, src.slice(2)));
    } else if (src.startsWith('$lib/')) bases.push(path.join(root, 'src/lib', src.slice(5)));
    else if (src.startsWith('/')) bases.push(path.join(root, src));
    else return null;                    // bare package / workspace alias — not resolvable here
    const exts = ['', '.tsx', '.ts', '.jsx', '.js', '.mjs', '.vue', '.svelte', '.astro'];
    for (const b of bases) {
        for (const e of exts) if (isFile(b + e)) return b + e;
        for (const e of exts.slice(1)) if (isFile(path.join(b, 'index' + e))) return path.join(b, 'index' + e);
    }
    return null;
}
function findUnder(root, relDirs, tail) {
    for (const d of relDirs) {
        const p = path.join(root, d, tail);
        if (isFile(p)) return p;
    }
    return null;
}
function extractComponentRefs(text, relFile, root) {
    const refs = new Map();
    const abs = path.join(root, relFile);
    const dir = path.dirname(abs);
    const rel = p => path.relative(root, p).split(path.sep).join('/');
    const add = (name, file) => { if (!refs.has(name)) refs.set(name, { name, file: file ? rel(file) : null }); };
    const ext = path.extname(relFile).toLowerCase();

    // JSX / TSX / Vue / Svelte / Astro: PascalCase tags resolved through imports.
    if (['.tsx', '.jsx', '.js', '.ts', '.mjs', '.vue', '.svelte', '.astro'].includes(ext)) {
        const imports = new Map();
        for (const m of text.matchAll(/import\s+(?:type\s+)?(?:(\w+)|\{([^}]*)\}|(\w+)\s*,\s*\{([^}]*)\})\s+from\s+['"]([^'"]+)['"]/g)) {
            const names = [];
            if (m[1]) names.push(m[1]);
            if (m[3]) names.push(m[3]);
            for (const g of [m[2], m[4]]) if (g) for (const part of g.split(',')) {
                const n = part.trim().split(/\s+as\s+/).pop().trim();
                if (n) names.push(n);
            }
            for (const n of names) imports.set(n, m[5]);
        }
        // JSX tags only: a generic (useState<Props>, FC<Params>) has an identifier
        // or a closing bracket right before the `<`; a JSX tag never does.
        for (const m of text.matchAll(/(?<![A-Za-z0-9_$\])])<([A-Z][A-Za-z0-9]*)(?:\.[A-Z][A-Za-z0-9]*)*(?=[\s/>])/g)) {
            const name = m[1];
            if (UI_PRIMITIVES.has(name) || PRIMITIVE_SUFFIX_RE.test(name) || ICON_PREFIX_RE.test(name)) continue;
            const src = imports.get(name);
            add(name, src ? resolveModule(src, dir, root) : null);
        }
    }
    // Rails partials + ViewComponent.
    if (/\.(?:erb|haml|slim)$/.test(ext) || ext === '.rb') {
        for (const m of text.matchAll(/render\s*\(?\s*(?:partial:\s*)?['"]([\w\/.-]+)['"]/g)) {
            const name = m[1];
            let file = null;
            const base = name.split('/').pop();
            const viewsRoot = abs.includes('/app/views/') ? abs.slice(0, abs.indexOf('/app/views/') + '/app/views/'.length) : null;
            const dirs = name.includes('/') && viewsRoot ? [path.join(viewsRoot, path.dirname(name))] : [dir];
            for (const d of dirs) for (const e of ['.html.erb', '.html.haml', '.html.slim', '.turbo_stream.erb']) {
                const p = path.join(d, `_${base}${e}`);
                if (isFile(p)) { file = p; break; }
            }
            add(name, file);
        }
        for (const m of text.matchAll(/render\s*\(?\s*([A-Z][A-Za-z0-9:]*Component)\.new/g)) {
            const snake = m[1].replace(/::/g, '/').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
            add(m[1], findUnder(root, ['app/components'], `${snake}.html.erb`) || findUnder(root, ['app/components'], `${snake}.rb`));
        }
    }
    // Laravel Blade / Livewire.
    if (ext === '.php' && /\.blade\.php$/.test(relFile)) {
        for (const m of text.matchAll(/@include(?:If|When|Unless)?\(\s*(?:[^,]+,\s*)?['"]([\w.-]+)['"]/g)) {
            add(m[1], findUnder(root, ['resources/views'], m[1].replace(/\./g, '/') + '.blade.php'));
        }
        for (const m of text.matchAll(/<x-([\w.-]+)[\s/>]/g)) {
            add(`x-${m[1]}`, findUnder(root, ['resources/views/components'], m[1].replace(/\./g, '/') + '.blade.php'));
        }
        for (const m of text.matchAll(/<livewire:([\w.-]+)[\s/>]/g)) {
            add(`livewire:${m[1]}`, findUnder(root, ['resources/views/livewire'], m[1].replace(/\./g, '/') + '.blade.php'));
        }
    }
    // Plain PHP (WordPress admin): require/include of another admin file.
    if (ext === '.php' && !/\.blade\.php$/.test(relFile)) {
        for (const m of text.matchAll(/\b(?:require|include)(?:_once)?\s*\(?\s*(?:ABSPATH\s*\.\s*)?['"]([\w\/.-]+\.php)['"]/g)) {
            const p = isFile(path.join(root, m[1])) ? path.join(root, m[1]) : (isFile(path.join(dir, m[1])) ? path.join(dir, m[1]) : null);
            add(m[1], p);
        }
        for (const m of text.matchAll(/\bget_template_part\(\s*['"]([\w\/.-]+)['"]/g)) add(m[1], null);
    }
    // Django / Jinja / Twig / Nunjucks / Liquid includes.
    for (const m of text.matchAll(/\{%-?\s*(?:include|extends|embed)\s+['"]([\w\/.-]+)['"]/g)) {
        let p = null;
        for (let d = dir; d.startsWith(root) && !p; d = path.dirname(d)) {
            const cand = path.join(d, m[1]);
            if (isFile(cand)) p = cand;
            else if (isFile(path.join(d, 'templates', m[1]))) p = path.join(d, 'templates', m[1]);
            if (d === root) break;
        }
        add(m[1], p);
    }
    // Razor partials.
    if (ext === '.cshtml') {
        for (const m of text.matchAll(/(?:<partial\s+name\s*=\s*["']([\w.-]+)["']|Partial(?:Async)?\(\s*["']([\w.-]+)["'])/g)) {
            const name = m[1] || m[2];
            add(name, findUnder(root, [rel(dir), 'Views/Shared', 'Areas/Admin/Views/Shared', 'Pages/Shared'], `${name}.cshtml`));
        }
    }
    // Angular custom elements and Phoenix function components: name-only.
    if (ext === '.html' || ext === '.heex' || ext === '.eex') {
        for (const m of text.matchAll(/<(app-[a-z0-9-]+|[a-z][a-z0-9]*-[a-z0-9-]+)[\s/>]/g)) add(m[1], null);
        for (const m of text.matchAll(/<\.([a-z_][a-z0-9_]*)[\s/>]/g)) add(`.${m[1]}`, null);
        for (const m of text.matchAll(/<([A-Z][\w.]*\.[a-z_][a-z0-9_]*)[\s/>]/g)) add(m[1], null);
    }
    return [...refs.values()];
}
function extractFormFields(text) {
    const names = [];
    for (const m of text.matchAll(/<(input|select|textarea)\b([^>]*)>/gi)) {
        if (m[1].toLowerCase() === 'input' && /\btype\s*=\s*["']?hidden\b/i.test(m[2])) continue;
        const n = m[2].match(/\bname\s*=\s*["']([^"']+)["']/i);
        if (n) names.push(n[1]);
    }
    for (const re of [
        /\bf(?:orm)?\.(?:text_field|email_field|password_field|number_field|text_area|select|collection_select|check_box|date_field|file_field|url_field|telephone_field|rich_text_area|search_field)\s*\(?\s*:(\w+)/g,
        /\bregister\(\s*['"]([\w.\[\]]+)['"]/g,
        /<(?:FormField|Field|Form\.Item|TextField|Input|Select|Textarea|Checkbox|Switch|InputField|SelectField|Controller)\b[^>]*\bname\s*=\s*["'{]([^"'}]+)["'}]/g,
        /\bwire:model(?:\.\w+)*\s*=\s*["']([\w.]+)["']/g,
        /\bv-model\s*=\s*["']([\w.]+)["']/g,
        /\bformControlName\s*=\s*["']([\w.]+)["']/g,
        /<\.input\b[^>]*\bfield=\{[^}]*\[:(\w+)\]/g,
        /\basp-for\s*=\s*["']([\w.]+)["']/g,
    ]) for (const m of text.matchAll(re)) names.push(m[1]);
    return uniq(names.map(n => n.replace(/\[\]$/, '')).filter(n => /^[\w.\[\]-]{2,60}$/.test(n)));
}
function humanize(name) {
    const last = name.split(/[.\[\]]/).filter(Boolean).pop() || name;
    return last.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
        .replace(/^\w/, c => c.toUpperCase());
}

// ─── ticket assembly ─────────────────────────────────────────────────────────
function buildTicket(ctx, block) {
    const { root, articleDir, vs, lint, pm, shell, maxEdits } = ctx;
    const entry = block.entry;
    const htmlPath = path.join(articleDir, block.html);
    const html = readText(htmlPath, 4 * 1024 * 1024);
    const htmlText = extractVisibleText(html);
    const htmlTextLower = htmlText.toLowerCase();
    const tokens = attrTokens(html);
    const htmlLower = html.toLowerCase();
    const inHtml = s => html.includes(s);
    // Presence for source-derived labels: visible text OR any attribute value
    // (placeholders paint; a copied aria-label proves the markup was copied).
    const inText = s => htmlLower.includes(String(s).toLowerCase());
    const lintEntry = lintEntryFor(lint, block);
    const metrics = (lintEntry && lintEntry.metrics) || {};
    const errors = (lintEntry && lintEntry.errors) || [];
    const warnings = (lintEntry && lintEntry.warnings) || [];
    const diag = readJson(path.join(articleDir, block.diagnostics)) || {};
    const dm = diag.metrics || {};
    const quality = diag.qualityScore || {};
    const evidenceVis = Array.isArray(dm.evidenceVisibility) ? dm.evidenceVisibility : [];
    const probeVis = Array.isArray(dm.probeVisibility) ? dm.probeVisibility : [];
    const visibility = new Map();
    for (const v of [...evidenceVis, ...probeVis]) if (v && typeof v.string === 'string') visibility.set(norm(v.string), Boolean(v.visible));
    const layout = layoutFor(pm, entry.layout);
    const chromeFiles = ((layout && layout.chrome) || []).filter(f => !NON_SOURCE_PATH_RE.test(f));
    const partials = Array.isArray(entry.partials_expanded)
        ? entry.partials_expanded.filter(p => typeof p === 'string' && !NON_SOURCE_PATH_RE.test(p)) : [];
    const primary = typeof entry.primary_view === 'string' && !NON_SOURCE_PATH_RE.test(entry.primary_view) ? entry.primary_view : null;
    const absence = absenceStrings(entry);
    const targets = actionTargetsFor(vs, block);

    const questions = [];
    let qn = 0;
    const ask = (kind, severity, source, text, check, extra) => {
        questions.push({ id: `${block.key}#${++qn}`, kind, severity, source, text, check, ...(extra || {}) });
    };

    // 1. Lint errors — verbatim; the Phase 3 loop should have cleared them, but a
    //    run that finished with a red lint still gets the pointer.
    for (const e of errors) ask('lint_error', 'blocking', 'lint_report.json', e, { type: 'lint_errors_zero' });

    // 2. Shell labels. The shell applies only to layouts the map ties it to: skip
    //    when the block claims a layout the map records as shell-hiding
    //    (chrome: [] + runtime_chrome — the fullscreen-editor case the lint's
    //    mode-contradiction check would reject anyway), a layout other than
    //    app_shell.layout when the map names one, or a layout whose own
    //    description says it has no sidebar. A block claiming a layout the map
    //    does not know is treated as shell-less too — a sidebar added on a
    //    guess is the wrong-mode failure, not polish.
    let shellHidden = false;
    let shellHiddenWhy = null;
    if (layout && Array.isArray(layout.chrome) && layout.chrome.length === 0 && layout.runtime_chrome) {
        shellHidden = true; shellHiddenWhy = 'layout records chrome: [] with a runtime_chrome recipe';
    } else if (layout && shell && shell.layout && layout.name && shell.layout !== layout.name && shell.layout !== layout.path) {
        shellHidden = true; shellHiddenWhy = `app_shell belongs to layout '${shell.layout}', this block claims '${layout.name}'`;
    } else if (layout && SHELL_ABSENT_RE.test(`${layout.area || ''} ${layout.name || ''}`)) {
        shellHidden = true; shellHiddenWhy = `layout '${layout.name || layout.path}' describes itself as shell-less`;
    } else if (!layout && entry.layout) {
        shellHidden = true; shellHiddenWhy = `claimed layout '${entry.layout}' is not in the project map`;
    } else if (!layout && !entry.layout && (!pm || (pm.app_type || 'web') === 'web') && Array.isArray(pm && pm.layouts) && pm.layouts.length) {
        // Web blocks name their layout; one that names none (a fullscreen editor,
        // a modal-only state) did not claim the shell's layout. Non-web modes omit
        // `layout` by contract, so their shell (tab bar, status bar) still applies.
        shellHidden = true; shellHiddenWhy = 'block claims no layout in a web app whose shell is layout-bound';
    }
    const navRatio = ratioOf(metrics.shell_nav_labels);
    if (shell && !shellHidden && shell.nav_labels.length >= 2) {
        const missing = shell.nav_labels.filter(l => !inHtml(l));
        const present = shell.nav_labels.filter(l => inHtml(l));
        if (navRatio !== null && navRatio < T.shell_labels && missing.length) {
            const severity = navRatio < T.shell_labels_blocking ? 'blocking' : 'advisory';
            ask('shell_labels_missing', severity, 'lint_report.json metrics.shell_nav_labels',
                `The map's app shell (${shell.type || 'shell'}) lists ${shell.nav_labels.length} navigation items; ` +
                `${missing.length} are absent from this mockup's text: ${missing.map(s => JSON.stringify(s)).join(', ')}. ` +
                `Open the PNG: if the real screen shows the shell here, add the missing items from the layout's chrome ` +
                `files${chromeFiles.length ? ` (${chromeFiles.join(', ')})` : ''} — every item, with its icon and ` +
                `badge where the map records one. If this surface genuinely hides the shell in this state, say so and leave it.`,
                { type: 'metric_ratio_min', key: 'shell_nav_labels', min: T.shell_labels },
                { missing, present });
        }
        // 2b. The render-visibility class: labels ARE in the HTML but paint nothing.
        const measured = present.filter(l => visibility.has(l));
        if (measured.length >= 2) {
            const hidden = measured.filter(l => visibility.get(l) === false);
            if (hidden.length * 2 > measured.length) {
                ask('shell_not_painting', 'blocking', `${block.diagnostics} metrics.probeVisibility`,
                    `The shell is in the HTML but not in the screenshot: ${hidden.length}/${measured.length} navigation labels ` +
                    `(${hidden.map(s => JSON.stringify(s)).join(', ')}) paint 0 px in the PNG. A copied class pair like ` +
                    `"hidden lg:flex" or a fixed/absolute sidebar the content flow never accounts for hides it at the capture width. ` +
                    `Make the authored shell VISIBLE (drop the hiding class, add an inline display, give the content the sidebar's ` +
                    `offset) — do not re-author it.`,
                    { type: 'probe_visible_majority', strings: measured }, { hidden });
            } else if (hidden.length) {
                ask('shell_item_hidden', 'advisory', `${block.diagnostics} metrics.probeVisibility`,
                    `${hidden.length} shell label(s) present in the HTML paint 0 px in the PNG: ` +
                    `${hidden.map(s => JSON.stringify(s)).join(', ')}. Check whether a class or clip hides them and make them visible.`,
                    { type: 'strings_visible', strings: hidden }, { hidden });
            }
        }
        // 2c. Footer / top-bar items the shell records — literal labels only, and
        //     only when the mockup renders the shell at all (majority of nav labels).
        const rendersShell = present.length * 2 >= shell.nav_labels.length;
        const footerLiteral = shell.footer_labels.filter(isLiteralLabel);
        const footerMissing = footerLiteral.filter(l => !inHtml(l));
        if (rendersShell && footerMissing.length) {
            ask('shell_footer_missing', 'advisory', 'project_map.json app_shell.footer_items',
                `The shell records ${footerLiteral.length} footer/bottom item(s); ${footerMissing.length} are absent: ` +
                `${footerMissing.map(s => JSON.stringify(s)).join(', ')}. The mockup renders the shell, so its bottom section ` +
                `should carry these too${shell.account_area ? ` (account area: ${shell.account_area})` : ''}.`,
                { type: 'html_contains_any', strings: footerMissing, min: Math.ceil(footerMissing.length / 2) });
        }
        if (shell.top_bar && rendersShell) {
            const items = [...shell.top_bar.items_left, ...shell.top_bar.items_right];
            const literal = items.filter(isLiteralLabel);
            const tbMissing = literal.filter(l => !inHtml(l));
            if (tbMissing.length) {
                ask('shell_top_bar_missing', 'advisory', 'project_map.json app_shell.top_bar',
                    `The shell's top bar records ${items.length} item(s); ${tbMissing.length} literal label(s) are absent: ` +
                    `${tbMissing.map(s => JSON.stringify(s)).join(', ')}. Render the bar at item level (badges and bubbles included).`,
                    { type: 'html_contains_any', strings: tbMissing, min: Math.ceil(tbMissing.length / 2) });
            }
        }
    }

    // 3. Chrome files the layout records but this block never expanded.
    const cfRatio = ratioOf(metrics.chrome_files_expanded);
    if (cfRatio !== null && cfRatio < T.chrome_files && chromeFiles.length) {
        const unexpanded = chromeFiles.filter(f => !partials.includes(f));
        if (unexpanded.length) {
            ask('chrome_file_unexpanded', errors.length ? 'advisory' : 'blocking', 'lint_report.json metrics.chrome_files_expanded',
                `Layout '${layout.name || layout.path}' renders these chrome files around the content on every page, and this ` +
                `block never expanded them: ${unexpanded.join(', ')}. Open each one, compare the region it emits with the PNG, ` +
                `add what is missing, and list the file in partials_expanded.`,
                { type: 'metric_ratio_min', key: 'chrome_files_expanded', min: T.chrome_files }, { unexpanded });
        }
    }

    // 4. Runtime-widget chrome strings (fullscreen editors and other JS-drawn surfaces).
    const rsRatio = ratioOf(metrics.runtime_ui_strings);
    if (rsRatio !== null && rsRatio < T.runtime_strings && layout && layout.runtime_chrome) {
        const rc = layout.runtime_chrome;
        const strings = uniq([...(rc.ui_strings || []), ...((rc.regions || []).flatMap(r => (r && r.ui_strings) || []))]
            .filter(s => typeof s === 'string' && s.length >= 2));
        const missing = strings.filter(s => !inHtml(s));
        ask('runtime_strings_missing', 'advisory', 'lint_report.json metrics.runtime_ui_strings',
            `Layout '${layout.name || layout.path}' records the embedded app's chrome (${(rc.regions || []).length} region(s)); ` +
            `${missing.length}/${strings.length} recorded UI strings are absent: ` +
            `${missing.slice(0, 12).map(s => JSON.stringify(s)).join(', ')}${missing.length > 12 ? ', …' : ''}. ` +
            `Compare the PNG against the recipe's regions in their recorded order and add the regions that are missing.`,
            { type: 'metric_ratio_min', key: 'runtime_ui_strings', min: T.runtime_strings }, { missing: missing.slice(0, 40) });
    }

    // 5. Render diagnostics: content deductions only (failed external resources are not the model's).
    const deductions = Array.isArray(quality.deductions) ? quality.deductions : [];
    const contentDeductions = deductions.filter(d => CONTENT_DEDUCTION_RE.test(String(d)));
    if (contentDeductions.length || quality.rating === 'poor') {
        ask('render_quality', quality.rating === 'poor' ? 'blocking' : 'advisory', `${block.diagnostics} qualityScore`,
            `The render scored ${quality.score ?? '?'} (${quality.rating || '?'}): ${contentDeductions.join('; ') || deductions.join('; ')}. ` +
            `Open the PNG — the content is blank, collapsed, or cut off. Fix the layout so the subject paints inside the frame.`,
            { type: 'render_deductions_absent' });
    }

    // 6. Evidence and action targets that paint nothing.
    const evInvisible = evidenceVis.filter(v => v && v.visible === false).map(v => norm(v.string));
    if (evInvisible.length) {
        ask('evidence_invisible', evInvisible.length * 2 > evidenceVis.length ? 'blocking' : 'advisory',
            `${block.diagnostics} metrics.evidenceVisibility`,
            `${evInvisible.length}/${evidenceVis.length} evidence labels have no visible text or matching visible control in the PNG: ` +
            `${evInvisible.map(s => JSON.stringify(s)).join(', ')}. Clipped out of frame or collapsed — depict the state where they are visible.`,
            { type: 'strings_visible', strings: evInvisible });
    }
    const targetInvisible = targets.filter(t => visibility.get(t.target) === false).map(t => t.target);
    if (targetInvisible.length) {
        ask('action_target_invisible', 'blocking', `${block.diagnostics} metrics.probeVisibility`,
            `This screenshot must show where the reader acts, and the action target(s) ` +
            `${targetInvisible.map(s => JSON.stringify(s)).join(', ')} have no visible matching control or text in the PNG. Make the control visible in its action-ready state.`,
            { type: 'strings_visible', strings: targetInvisible });
    }

    // 7. Lint warnings that name concrete gaps.
    const inventedCount = countOf(metrics.invented_copy);
    if (inventedCount) {
        const w = warnings.find(x => /do not appear in any listed source file/.test(x));
        const quoted = w ? (w.match(/"([^"]+)"/g) || []).join(', ') : '';
        ask('invented_copy', 'advisory', 'lint_report.json metrics.invented_copy',
            `${inventedCount} multi-word phrase(s) in the mockup exist in no listed source file${quoted ? ` (${quoted})` : ''}. ` +
            `Replace each with the real string from the source or locale file — copy is never paraphrased.`,
            { type: 'metric_count_max', key: 'invented_copy', max: 0 });
    }
    const ppRatio = ratioOf(metrics.partials_present);
    if (ppRatio !== null && ppRatio < 1) {
        const missing = partials.filter(p => !isFile(path.join(root, p)));
        ask('partial_missing', 'advisory', 'lint_report.json metrics.partials_present',
            `partials_expanded lists file(s) that do not exist: ${missing.join(', ')}. Correct the path(s) in view_sources.json ` +
            `(and open the real file — a partial you could not open is a region you could not copy).`,
            { type: 'metric_ratio_min', key: 'partials_present', min: 1 });
    }
    const scRatio = ratioOf(metrics.styled_coverage);
    const scTotal = metrics.styled_coverage && metrics.styled_coverage.total;
    if (scRatio !== null && scRatio < T.styled_coverage && scTotal >= T.styled_min_total) {
        const w = warnings.find(x => /unmatched:/.test(x));
        const sample = w ? (w.match(/unmatched:\s*([^)]+)\)/) || [])[1] : null;
        ask('styled_coverage_low', 'advisory', 'lint_report.json metrics.styled_coverage',
            `Only ${Math.round(scRatio * 100)}% of this mockup's class/id tokens match a selector in branding.css/mockup.css` +
            `${sample ? ` (unmatched sample: ${sample})` : ''}. Open the PNG: regions that look bare are usually classes the ` +
            `bundle never styles. Where a region looks unstyled, prefer classes that exist in branding.css/mockup.css; ` +
            `leave regions that already look right alone.`,
            { type: 'metric_ratio_min', key: 'styled_coverage', min: T.styled_coverage });
    }

    // 8. Source-derived questions — independent of the map's chrome inventory, so
    //    thin maps still get a pointer. Bounded file set, bounded output.
    const scanFiles = uniq([primary, ...chromeFiles].filter(Boolean)).filter(f => isFile(path.join(root, f))).slice(0, CAPS.scan_files);
    const componentFiles = uniq([primary, layout && layout.path, ...chromeFiles].filter(Boolean)).filter(f => isFile(path.join(root, f))).slice(0, CAPS.scan_files);
    const locale = buildLocaleIndex(root, partials);
    const sourceTexts = new Map();
    const textOf = f => { if (!sourceTexts.has(f)) sourceTexts.set(f, readText(path.join(root, f))); return sourceTexts.get(f); };

    // 8a. Components / partials the rendered files include that leave no trace in the mockup.
    const unrendered = [];
    const seenComponents = new Set();
    for (const f of componentFiles) {
        for (const ref of extractComponentRefs(textOf(f), f, root)) {
            if (seenComponents.has(ref.name)) continue;
            seenComponents.add(ref.name);
            if (OVERLAY_NAME_RE.test(ref.name) || (ref.file && OVERLAY_NAME_RE.test(path.basename(ref.file)))) continue;
            const toks = nameTokens(ref.name.replace(/^[.@]|^x-|^livewire:/, '').replace(/^_/, ''));
            if (toks.some(t => t && (tokens.has(t) || [...tokens].some(x => x.includes(t) && t.length >= 5)))) continue;
            let labels = [];
            if (ref.file) {
                const ft = textOf(ref.file);
                labels = extractLabels(ft, { nav: true });
                const keys = extractI18nKeys(ft).map(k => locale.lookup(k, lazyPrefixFor(ref.file))).filter(Boolean);
                labels = uniq([...labels, ...keys]);
                if (labels.some(l => inText(l))) continue;
            } else if (!/[.\-_:]/.test(ref.name) && ref.name.length < 6) {
                continue;   // short unresolved PascalCase tags are too noisy to ticket
            }
            unrendered.push({ name: ref.name, file: ref.file, rendered_by: f, labels: labels.slice(0, 4) });
            if (unrendered.length >= CAPS.components) break;
        }
        if (unrendered.length >= CAPS.components) break;
    }
    if (unrendered.length) {
        ask('source_component_unrendered', 'advisory', 'source files',
            `These components/partials are rendered by the files this screen is built from, and nothing in the mockup ` +
            `corresponds to them: ${unrendered.map(u => `${u.name}${u.file ? ` (${u.file})` : ''} ← ${u.rendered_by}`).join('; ')}. ` +
            `Open each one: if it draws a region the real screen shows in this state, add that region; if it is conditional ` +
            `or empty for the default user, skip it.`,
            { type: 'html_contains_any', strings: uniq(unrendered.flatMap(u => [u.name, ...u.labels])), min: 1 }, { components: unrendered });
    }

    // 8a'. Screen closure: pieces the primary view renders UNCONDITIONALLY
    //      (includes + its own inline sections) that leave no trace in the mockup.
    //      Sharper than 8a because the census classifies by render condition —
    //      overlays and guarded pieces are exempt, so every item here is one the
    //      real screen shows in this state. Mirrors the lint's warn-only
    //      screen_closure check; modal steps (overlay primary_view) are skipped.
    if (primary && !includeCensus.OVERLAY_NAME_RE.test(path.basename(primary))) {
        const cen = includeCensus.census(root, primary);
        const pieces = [];
        for (const inc of cen.includes) if (inc.kind === 'unconditional' && inc.markers.length) pieces.push({ label: `${inc.name}${inc.file ? ` (${inc.file})` : ''}`, markers: inc.markers });
        for (const sec of cen.inline_sections) if (!sec.guarded && sec.markers.length) pieces.push({ label: `inline section "${sec.heading}"`, markers: sec.markers });
        const missing = pieces.filter(p => !p.markers.some(inText));
        if (missing.length) {
            // Blocking whenever ANY unconditional piece is missing: by construction every
            // item here is something the real screen shows in this state (overlays and
            // guarded pieces are already excluded), so there is no "advisory" reading.
            ask('screen_piece_missing', 'blocking', `source ${primary}`,
                `${primary} renders ${missing.length} piece(s) on every load that the mockup does not show: ` +
                `${missing.map(p => `${p.label} [e.g. ${p.markers.slice(0, 2).map(s => JSON.stringify(s)).join(', ')}]`).join('; ')}. ` +
                `The screen is the primary view plus every unconditional include and inline section; open the PNG and add each missing ` +
                `piece where the source places it. Overlays and guarded pieces are already excluded from this list.`,
                { type: 'html_contains_any', strings: uniq(missing.flatMap(p => p.markers.slice(0, 3))), min: missing.length }, { pieces: missing });
        }
    }

    // 8b. Labels the primary view and chrome files carry that the mockup lacks.
    //     Visible labels only, screen-shaped only (short, no sentence punctuation).
    const labelCandidates = [];
    for (const f of scanFiles) {
        const ft = textOf(f);
        const direct = extractLabels(ft, { nav: f !== primary, visibleOnly: true });
        const resolved = extractI18nKeys(ft).map(k => locale.lookup(k, lazyPrefixFor(f))).map(v => v && cleanLabel(v)).filter(Boolean);
        for (const l of uniq([...direct, ...resolved])) {
            if (l.length < 3 || l.length > 60 || !isScreenLabel(l)) continue;
            if (absence.some(a => l.toLowerCase().includes(a))) continue;
            if (inText(l)) continue;
            labelCandidates.push(l);
        }
    }
    const labelsMissing = uniq(labelCandidates);
    if (labelsMissing.length) {
        const shown = labelsMissing.slice(0, CAPS.labels);
        ask('source_labels_missing', 'advisory', 'source files',
            `${labelsMissing.length} label(s) from the source files this screen renders do not appear in the mockup` +
            `${labelsMissing.length > shown.length ? ` (first ${shown.length})` : ''}: ${shown.map(s => JSON.stringify(s)).join(', ')}. ` +
            `Many belong to other states or branches — open the PNG and add only the ones the real screen shows in this block's ` +
            `depicted state (headings, column headers, buttons, field labels, placeholders).`,
            { type: 'html_contains_any', strings: shown, min: Math.max(1, Math.ceil(shown.length / 2)) }, { labels: shown, total: labelsMissing.length });
    }

    // 8c. Form fields: the primary view declares N controls, the mockup renders far fewer.
    if (primary) {
        const fields = extractFormFields(textOf(primary));
        const mockupControls = countFormControls(html);
        if (fields.length >= 3 && mockupControls < Math.ceil(fields.length / 2)) {
            const missing = fields.filter(n => !inText(humanize(n)) && !tokens.has(n.toLowerCase())).slice(0, CAPS.form_fields);
            ask('source_form_fields_missing', 'advisory', `source ${primary}`,
                `${primary} declares ${fields.length} form field(s) and the mockup renders ${mockupControls} control(s). ` +
                `Absent by name: ${missing.map(n => JSON.stringify(humanize(n))).join(', ')}. Open the PNG and add the fields the ` +
                `real form shows in this state, each with its label, placeholder and control type from the source.`,
                { type: 'html_control_count_min', min: Math.ceil(fields.length / 2) }, { fields: missing });
        }
    }

    // 8d. Navigation from the layout/chrome files when the map's shell is thin.
    if ((!shell || shell.nav_labels.length < 2) && (layout || chromeFiles.length)) {
        const navFiles = uniq([layout && layout.path, ...chromeFiles].filter(Boolean)).filter(f => isFile(path.join(root, f))).slice(0, CAPS.scan_files);
        const navLabels = [];
        for (const f of navFiles) {
            const ft = textOf(f);
            for (const m of ft.matchAll(/<nav\b[\s\S]{0,6000}?<\/nav>/gi)) navLabels.push(...extractLabels(m[0], { nav: true }));
            navLabels.push(...extractI18nKeys(ft).map(k => locale.lookup(k, lazyPrefixFor(f))).filter(Boolean));
        }
        const missing = uniq(navLabels).filter(l => !inText(l)).slice(0, CAPS.nav);
        if (missing.length >= 2) {
            ask('source_nav_missing', 'advisory', 'layout / chrome source files',
                `The map records no shell navigation, but the layout's own markup carries navigation labels the mockup lacks: ` +
                `${missing.map(s => JSON.stringify(s)).join(', ')}. Open the PNG: if the real page shows this navigation, add it.`,
                { type: 'html_contains_any', strings: missing, min: Math.ceil(missing.length / 2) });
        }
    }

    // 9. Always: the open comparison.
    const readOrder = uniq([primary, layout && layout.path, ...chromeFiles, ...partials].filter(Boolean))
        .filter(f => isFile(path.join(root, f)));
    const ordered = [...readOrder.filter(f => !isLocaleFile(f)), ...readOrder.filter(isLocaleFile)].slice(0, CAPS.read_order);
    ask('compare', 'advisory', 'PNG + source files',
        `Open ${block.png}, then each file in sources.read_order. List what the real screen shows that the PNG does not — ` +
        `regions, rows and their columns, controls, labels, badges, footers — and add it. If nothing is missing, say so.`,
        { type: 'manual' });

    const blocking = questions.filter(q => q.severity === 'blocking').length;
    return {
        block_id: block.block_id, index: block.index, key: block.key,
        html: block.html,
        html_raw: isFile(path.join(articleDir, block.pre)) ? block.pre : null,
        png: block.png,
        sha256: {
            html: sha256File(htmlPath),
            html_raw: sha256File(path.join(articleDir, block.pre)),
            png: sha256File(path.join(articleDir, block.png)),
        },
        url_or_route: entry.url_or_route || null,
        depicted_state: typeof entry.depicted_state === 'string' ? entry.depicted_state : null,
        sources: {
            primary_view: primary,
            layout: layout ? { name: layout.name, path: layout.path, area: layout.area, shell_hidden: shellHidden } : (entry.layout || null),
            chrome_files: chromeFiles,
            partials_expanded: partials,
            read_order: ordered,
        },
        shell: shell && !shellHidden ? {
            type: shell.type, nav_items: shell.nav_labels_all, footer_items: shell.footer_labels,
            account_area: shell.account_area, top_bar: shell.top_bar, notes: shell.notes,
        } : null,
        action_targets: targets,
        before: {
            metrics: Object.keys(metrics).length ? metrics : null,
            chrome: chromeMean(metrics),
            render_score: typeof quality.score === 'number' ? quality.score : null,
            render_rating: quality.rating || null,
            deductions,
            errors, warnings,
        },
        questions,
        counts: { questions: questions.length, blocking, advisory: questions.length - blocking },
        budget: { max_edits: maxEdits },
    };
}

function buildTickets(articleDir, root, env = process.env) {
    const maxEdits = intEnv('RTFM_POLISH_MAX_EDITS', 6, env);
    const maxBlocks = intEnv('RTFM_POLISH_MAX_BLOCKS', 0, env);
    const vs = readJson(path.join(articleDir, 'view_sources.json'));
    const lint = readJson(path.join(articleDir, 'lint_report.json'));
    const pm = loadProjectMap(root);
    const shell = shellSummary(pm);
    const ctx = { root, articleDir, vs, lint, pm, shell, maxEdits };
    const out = {
        schema_version: SCHEMA_VERSION, enabled: true,
        generated_at: new Date().toISOString(),
        article_dir: path.resolve(articleDir), project_root: path.resolve(root),
        app_type: (pm && pm.app_type) || 'web',
        inputs: {
            view_sources: Boolean(vs), lint_report: Boolean(lint), project_map: Boolean(pm),
            app_shell: Boolean(shell),
        },
        budget: { max_edits: maxEdits, max_blocks: maxBlocks },
        blocks: [], skipped: [],
    };
    if (!vs) {
        out.skipped.push({ reason: 'no-view-sources' });
        return out;
    }
    const tickets = [];
    for (const block of blockEntries(vs)) {
        if (block.entry.external_surface) { out.skipped.push({ block: block.key, reason: 'external-surface' }); continue; }
        if (!isFile(path.join(articleDir, block.html))) { out.skipped.push({ block: block.key, reason: 'no-html' }); continue; }
        if (!isFile(path.join(articleDir, block.png))) { out.skipped.push({ block: block.key, reason: 'no-png' }); continue; }
        tickets.push(buildTicket(ctx, block));
    }
    // Worst first: blocking desc, advisory desc, then authored order.
    const order = new Map(tickets.map((t, i) => [t.key, i]));
    tickets.sort((a, b) => (b.counts.blocking - a.counts.blocking)
        || (b.counts.advisory - a.counts.advisory) || (order.get(a.key) - order.get(b.key)));
    if (maxBlocks > 0 && tickets.length > maxBlocks) {
        for (const t of tickets.slice(maxBlocks)) out.skipped.push({ block: t.key, reason: 'over-block-cap' });
        out.blocks = tickets.slice(0, maxBlocks);
    } else out.blocks = tickets;
    out.totals = {
        blocks_ticketed: out.blocks.length,
        questions: out.blocks.reduce((n, t) => n + t.counts.questions, 0),
        blocking: out.blocks.reduce((n, t) => n + t.counts.blocking, 0),
    };
    return out;
}

// ─── report ──────────────────────────────────────────────────────────────────
function evaluateCheck(check, after) {
    if (!check || typeof check !== 'object') return null;
    const m = after.metrics || {};
    switch (check.type) {
        case 'manual': return null;
        case 'lint_errors_zero': return after.errors.length === 0;
        case 'metric_ratio_min': { const r = ratioOf(m[check.key]); return r === null ? null : r >= check.min; }
        case 'metric_count_max': { const c = countOf(m[check.key]); return c === null ? true : c <= check.max; }
        case 'render_deductions_absent':
            return after.rating !== 'poor' && !after.deductions.some(d => CONTENT_DEDUCTION_RE.test(String(d)));
        case 'strings_visible':
            return (check.strings || []).every(s => after.visibility.get(norm(s)) === true);
        case 'probe_visible_majority': {
            const vis = (check.strings || []).filter(s => after.visibility.get(norm(s)) === true).length;
            return vis * 2 > (check.strings || []).length;
        }
        case 'html_contains_all': return (check.strings || []).every(s => after.html.includes(s));
        case 'html_contains_any': {
            const n = (check.strings || []).filter(s => after.html.includes(s) || after.textLower.includes(String(s).toLowerCase())).length;
            return n >= (check.min || 1);
        }
        case 'html_control_count_min': return countFormControls(after.html) >= check.min;
        default: return null;
    }
}
function buildReport(articleDir, root) {
    const tickets = readJson(path.join(articleDir, 'polish_tickets.json'));
    const report = { schema_version: SCHEMA_VERSION, generated_at: new Date().toISOString(), enabled: Boolean(tickets && tickets.enabled) };
    if (!tickets) { report.error = 'polish_tickets.json missing or unreadable'; report.blocks = []; report.totals = null; return report; }
    if (!tickets.enabled) { report.blocks = []; report.totals = null; return report; }
    const lint = readJson(path.join(articleDir, 'lint_report.json'));
    const vs = readJson(path.join(articleDir, 'view_sources.json'));
    const blocks = blockEntries(vs || {});
    report.blocks = [];
    for (const t of tickets.blocks || []) {
        const block = blocks.find(b => b.key === t.key) || {
            key: t.key, block_id: t.block_id, index: t.index, html: t.html, pre: `${t.html}.pre`, png: t.png,
            diagnostics: `${t.html.replace(/\.html$/, '')}_diagnostics.json`,
        };
        const lintEntry = lintEntryFor(lint, block);
        const diag = readJson(path.join(articleDir, block.diagnostics)) || {};
        const dm = diag.metrics || {};
        const visibility = new Map();
        for (const v of [...(dm.evidenceVisibility || []), ...(dm.probeVisibility || [])]) {
            if (v && typeof v.string === 'string') visibility.set(norm(v.string), Boolean(v.visible));
        }
        const html = readText(path.join(articleDir, block.html), 4 * 1024 * 1024);
        const after = {
            metrics: (lintEntry && lintEntry.metrics) || {},
            errors: (lintEntry && lintEntry.errors) || [],
            warnings: (lintEntry && lintEntry.warnings) || [],
            rating: (diag.qualityScore || {}).rating || null,
            score: typeof (diag.qualityScore || {}).score === 'number' ? diag.qualityScore.score : null,
            deductions: (diag.qualityScore || {}).deductions || [],
            visibility, html, textLower: extractVisibleText(html).toLowerCase(),
        };
        const results = (t.questions || []).map(q => ({
            id: q.id, kind: q.kind, severity: q.severity, check: q.check && q.check.type, resolved: evaluateCheck(q.check, after),
        }));
        const checkable = results.filter(r => r.resolved !== null);
        const rawSha = sha256File(path.join(articleDir, block.pre));
        const htmlSha = sha256File(path.join(articleDir, block.html));
        const beforeRaw = t.sha256 && t.sha256.html_raw;
        const htmlChanged = beforeRaw && rawSha ? rawSha !== beforeRaw : (t.sha256 ? htmlSha !== t.sha256.html : null);
        const pngSha = sha256File(path.join(articleDir, block.png));
        report.blocks.push({
            key: t.key, block_id: t.block_id, index: t.index,
            questions_total: results.length,
            blocking: results.filter(r => r.severity === 'blocking').length,
            checkable: checkable.length,
            resolved: checkable.filter(r => r.resolved === true).length,
            unresolved: checkable.filter(r => r.resolved === false).map(r => ({ id: r.id, kind: r.kind, severity: r.severity })),
            questions: results,
            html_changed: htmlChanged,
            png_changed: t.sha256 && t.sha256.png && pngSha ? pngSha !== t.sha256.png : null,
            render_before: (t.before || {}).render_score ?? null,
            render_after: after.score,
            chrome_before: (t.before || {}).chrome ?? null,
            chrome_after: chromeMean(after.metrics),
            errors_after: after.errors.length,
            warnings_after: after.warnings.length,
        });
    }
    const b = report.blocks;
    report.totals = {
        blocks_ticketed: b.length,
        questions: b.reduce((n, x) => n + x.questions_total, 0),
        blocking: b.reduce((n, x) => n + x.blocking, 0),
        checkable: b.reduce((n, x) => n + x.checkable, 0),
        resolved: b.reduce((n, x) => n + x.resolved, 0),
        blocks_html_changed: b.filter(x => x.html_changed === true).length,
        blocks_png_changed: b.filter(x => x.png_changed === true).length,
        blocks_with_errors_after: b.filter(x => x.errors_after > 0).length,
    };
    return report;
}

// ─── CLI ─────────────────────────────────────────────────────────────────────
function main(argv = process.argv.slice(2), env = process.env) {
    const positional = argv.filter(a => !a.startsWith('--'));
    const reportMode = argv.includes('--report');
    const articleDir = positional[0];
    if (!articleDir || !fs.existsSync(articleDir)) {
        console.log('Usage: polish_tickets.js <article_dir> [project_root] [--report]');
        return 0;
    }
    const lintForRoot = readJson(path.join(articleDir, 'lint_report.json'));
    const rootArg = positional[1] || (lintForRoot && typeof lintForRoot.project_dir === 'string' && lintForRoot.project_dir !== '.' ? lintForRoot.project_dir : null);
    const root = path.resolve(rootArg || process.cwd());
    const outFile = path.join(articleDir, reportMode ? 'polish_report.json' : 'polish_tickets.json');

    if (!polishEnabled(env)) {
        const disabled = reportMode
            ? { schema_version: SCHEMA_VERSION, enabled: false, blocks: [], totals: null }
            : { schema_version: SCHEMA_VERSION, enabled: false, blocks: [], skipped: [] };
        fs.writeFileSync(outFile, JSON.stringify(disabled, null, 2));
        console.log('polish: disabled');
        return 0;
    }
    if (reportMode) {
        const report = buildReport(articleDir, root);
        fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
        if (!report.enabled) { console.log('polish: disabled'); return 0; }
        const tt = report.totals || {};
        console.log(`polish: ${tt.blocks_ticketed || 0} block(s) ticketed, ${tt.questions || 0} question(s) ` +
            `(${tt.checkable || 0} checkable) — resolved ${tt.resolved || 0}/${tt.checkable || 0}; ` +
            `HTML changed ${tt.blocks_html_changed || 0}/${tt.blocks_ticketed || 0}, PNG changed ${tt.blocks_png_changed || 0}/${tt.blocks_ticketed || 0}` +
            `${tt.blocks_with_errors_after ? `; ${tt.blocks_with_errors_after} block(s) still have lint errors` : ''}`);
        for (const b of report.blocks) {
            const label = b.block_id !== null && b.block_id !== undefined ? `block_${b.block_id}` : `step_${b.index}`;
            console.log(`  ${label}: resolved ${b.resolved}/${b.checkable}` +
                `${b.unresolved.length ? ` (open: ${b.unresolved.map(u => u.kind).join(', ')})` : ''}` +
                `; html ${b.html_changed === null ? '?' : (b.html_changed ? 'changed' : 'unchanged')}` +
                `, png ${b.png_changed === null ? '?' : (b.png_changed ? 'changed' : 'unchanged')}` +
                `; render ${b.render_before ?? '?'}→${b.render_after ?? '?'}; chrome ${b.chrome_before ?? '–'}→${b.chrome_after ?? '–'}`);
        }
        return 0;
    }
    const tickets = buildTickets(articleDir, root, env);
    fs.writeFileSync(outFile, JSON.stringify(tickets, null, 2));
    const tt = tickets.totals || { blocks_ticketed: 0, questions: 0, blocking: 0 };
    console.log(`polish: ${tt.blocks_ticketed} block(s) ticketed, ${tt.questions} question(s), ${tt.blocking} blocking ` +
        `(edit budget ${tickets.budget.max_edits}/block)${tickets.skipped.length ? `; skipped ${tickets.skipped.length}` : ''}`);
    for (const t of tickets.blocks) {
        console.log(`  ${t.html}: ${t.counts.questions} question(s), ${t.counts.blocking} blocking — Read ${t.png}, then ` +
            `${t.sources.read_order.length ? t.sources.read_order.join(', ') : '(no readable sources)'}`);
    }
    for (const s of tickets.skipped) console.log(`  skipped ${s.block || ''}: ${s.reason}`);
    if (argv.includes('--restore') && tickets.blocks.length) {
        let restored = 0;
        for (const t of tickets.blocks) {
            if (!t.html_raw) continue;
            try { fs.copyFileSync(path.join(articleDir, t.html_raw), path.join(articleDir, t.html)); restored++; } catch { /* keep injected */ }
        }
        console.log(`polish: ${restored} block(s) restored to their raw authored HTML (INJECT_CSS marker + {{img}} placeholders back) — ` +
            `edit those files; render_ready.js re-injects per block`);
    }
    if (!tickets.blocks.length) console.log('POLISH: nothing to do — skip the polish loop; the closing block below is still run.');
    else console.log(`POLISH: ${tickets.blocks.length} block(s) need a second look — for each, Read the PNG, then the sources, answer every question (blocking first), ADD what is missing, re-publish with render_ready.js.`);
    return 0;
}

if (require.main === module) {
    try { process.exitCode = main(); } catch (err) {
        console.log(`polish: tickets unavailable (${err.message})`);
        process.exitCode = 0;
    }
}

module.exports = {
    buildTickets, buildReport, evaluateCheck, polishEnabled, chromeMean,
    extractLabels, extractI18nKeys, extractComponentRefs, extractFormFields, LocaleIndex, shellSummary, layoutFor,
};
