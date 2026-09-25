/**
 * include_census.js — what a view CONTRIBUTES to the screen, framework-agnostic.
 *
 * A view file is a tree: its own inline sections plus the files it includes
 * (Rails partials / ViewComponents, JSX/Vue/Svelte components, Blade/Livewire,
 * Django/Jinja/Twig/Liquid includes, Razor partials, Phoenix/Angular custom
 * elements, plain PHP requires). For the mockup contract what matters is not the
 * syntax but the RENDER CONDITION of each piece:
 *
 *   unconditional — rendered on every load of the view: part of the screen
 *   overlay       — in the DOM but hidden until an action (modal/dialog/drawer/
 *                   popover/menu/toast): the host screen plus the overlay when a
 *                   step opens it; never a screen on its own
 *   conditional   — behind a guard (if/unless/&&/ternary/@if/{% if %}/v-if/…):
 *                   resolved for the default user (default_user_assumptions)
 *
 * The census is regex-only and bounded; it answers "which pieces must leave a
 * trace in the mockup" and hands back per-piece marker strings (headings, labels,
 * button text) that the lint and the polish tickets check for. It never fails a
 * run on its own — a piece with no usable markers is simply not checkable.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const OVERLAY_NAME_RE = /modal|dialog|drawer|sheet|toast|tooltip|popover|snackbar|lightbox|flash|offcanvas|dropdown-menu|context-menu/i;
const OVERLAY_ATTR_RE = /\b(?:class\s*=\s*["'][^"']*\b(?:modal|dialog|drawer|offcanvas|popover|dropdown-menu|toast)\b|role\s*=\s*["'](?:dialog|alertdialog|menu|tooltip)["']|hidden\b|display\s*:\s*none|x-show\s*=|v-show\s*=|aria-hidden\s*=\s*["']true)/i;
// A template guard OPENING near the piece (same line or the few lines above),
// and the closers that cancel it. `guardOpen(ctx)` walks the window in order so
// an `<% end %>` / `{% endif %}` / `@endif` above the piece does not count as a
// guard, while an unclosed `if` does.
const GUARD_RE = /(?:<%-?\s*(?:if|unless|elsif|else)\b|\{%-?\s*(?:if|elif|else|unless)\b|@(?:if|elseif|else|unless|auth|guest|can|isset|empty)\b|\bv-(?:if|else-if|else)\b|\*ngIf\b|@if\s*\(|\?\s*\(?<|&&\s*\(?<|\bif\s+[^:]*:\s*$|\bunless\s+[^:]*:\s*$|<%=?\s*if\b)/;
const GUARD_CLOSE_RE = /(?:<%-?\s*end\b|\{%-?\s*end(?:if|unless)\b|@end(?:if|unless|auth|guest|can|isset|empty)\b)/;
function guardOpen(ctx) {
    let depth = 0;
    for (const line of ctx.split('\n')) {
        if (GUARD_CLOSE_RE.test(line)) depth = Math.max(0, depth - 1);
        if (GUARD_RE.test(line)) depth += 1;
    }
    return depth > 0;
}
const SKIP_EXT_RE = /\.(?:json|ya?ml|arb|po|css|scss|sass|less|svg|png|jpe?g|gif|webp|ico|woff2?|ttf|md|txt|lock)$/i;
const READ_CAP = 400 * 1024;

function readText(p) {
    try {
        const st = fs.statSync(p);
        if (!st.isFile()) return '';
        const fd = fs.openSync(p, 'r');
        try {
            const len = Math.min(st.size, READ_CAP);
            const buf = Buffer.alloc(len);
            fs.readSync(fd, buf, 0, len, 0);
            return buf.toString('utf8');
        } finally { fs.closeSync(fd); }
    } catch { return ''; }
}
function isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }
function norm(s) { return String(s).replace(/\s+/g, ' ').trim(); }
function uniq(a) { return [...new Set(a)]; }

// ─── markers: short visible strings a piece paints ───────────────────────────
const TEMPLATE_NOISE_RE = /[{}<>]|<%|\$\{|#\{|%}|=>|\bt\(|\bI18n\b|__\(|\bthis\.|\bprops\.|\bstate\.|%\d*\$?[sd]|&#|\{\{|\$\w/;
function cleanMarker(s) {
    const t = norm(String(s).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&'));
    if (t.length < 3 || t.length > 60) return null;
    if (TEMPLATE_NOISE_RE.test(t)) return null;
    if (!/[A-Za-z]/.test(t)) return null;
    if (/^[a-z][A-Za-z0-9_]*$/.test(t) && /[A-Z_]/.test(t)) return null;
    if (/[.!?]$/.test(t) || t.split(' ').length > 6) return null;   // sentences are messages, not labels
    return t;
}
/** Visible-text markers in a chunk of template: headings, legends, buttons, labels, th, link text, placeholders. */
function extractMarkers(text) {
    const out = [];
    const push = s => { const c = cleanMarker(s); if (c) out.push(c); };
    for (const m of text.matchAll(/<(h[1-6]|legend|summary|th|button|label|a|option)\b[^>]*>([\s\S]{0,300}?)<\/\1>/gi)) push(m[2]);
    for (const m of text.matchAll(/<([A-Z][A-Za-z0-9.]*)\b[^>]*>([^<{}]{3,60})<\/\1>/g)) push(m[2]);
    for (const m of text.matchAll(/\bplaceholder\s*=\s*["']([^"'{}<>]{3,60})["']/gi)) push(m[1]);
    for (const m of text.matchAll(/\b(?:link_to|button_to|submit_tag|button_tag|label_tag)\s*\(?\s*["']([^"'{}<>#]{3,60})["']/g)) push(m[1]);
    for (const m of text.matchAll(/\b\w+\.(?:submit|button|label)\s*\(?\s*(?::\w+\s*,\s*)?["']([^"'{}<>#]{3,60})["']/g)) push(m[1]);
    for (const m of text.matchAll(/\b(?:__|_e|esc_html__|esc_html_e|esc_attr__|esc_attr_e|_x)\(\s*['"]([^'"]{3,60})['"]/g)) push(m[1]);
    return uniq(out);
}

// ─── include references with their call-site context ─────────────────────────
function findUnder(root, relDirs, tail) {
    for (const d of relDirs) { const p = path.join(root, d, tail); if (isFile(p)) return p; }
    return null;
}
// ─── module resolution (aliases, workspaces) ─────────────────────────────────
// Component-tree apps import through aliases (`@/`, `~/`, `$lib`) declared per
// PACKAGE (tsconfig `paths`, svelte/vite `alias`) and through workspace packages
// (`@calcom/ui/...`, `twenty-ui/...`). Resolving against the git root alone
// leaves every such import unresolved, so the chain walk never leaves the
// primary view. Everything here is bounded and cached per root; a miss is
// reported as `file: null`, never guessed.
const _rootCache = new Map();
function rootState(root) {
    let s = _rootCache.get(root);
    if (!s) { s = { workspaces: null, pkgDirs: new Map(), aliasConf: new Map() }; _rootCache.set(root, s); }
    return s;
}
// tsconfig/jsconfig are JSONC: comments and trailing commas. A regex stripper
// is unsafe here because alias keys like "~/*" contain comment openers, so the
// scanner tracks string state.
function stripJsonc(s) {
    let out = '', q = false;
    for (let i = 0; i < s.length; i++) {
        const ch = s[i], nx = s[i + 1];
        if (q) { out += ch; if (ch === '\\') { out += nx || ''; i++; } else if (ch === '"') q = false; continue; }
        if (ch === '"') { q = true; out += ch; continue; }
        if (ch === '/' && nx === '/') { while (i < s.length && s[i] !== '\n') i++; out += '\n'; continue; }
        if (ch === '/' && nx === '*') { const e = s.indexOf('*/', i + 2); i = e < 0 ? s.length : e + 1; continue; }
        out += ch;
    }
    return out.replace(/,(\s*[}\]])/g, '$1');
}
function readJsonLoose(p) {
    const t = readText(p);
    if (!t) return null;
    try { return JSON.parse(t); } catch { /* jsonc */ }
    try { return JSON.parse(stripJsonc(t)); } catch { return null; }
}
function listDirs(p) { try { return fs.readdirSync(p, { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules').map(d => path.join(p, d.name)); } catch { return []; } }
function expandWorkspaceGlob(root, pattern) {
    // "packages/*", "packages/**", "apps/api/*", "web" — at most two wildcard levels.
    const parts = pattern.replace(/\/+$/, '').split('/');
    let dirs = [root];
    for (const part of parts) {
        if (part === '*' || part === '**') {
            const next = [];
            for (const d of dirs) { const kids = listDirs(d); next.push(...kids); if (part === '**') for (const k of kids) next.push(...listDirs(k)); }
            dirs = next;
        } else dirs = dirs.map(d => path.join(d, part));
        if (dirs.length > 400) break;
    }
    return dirs;
}
function workspacePackages(root) {
    const s = rootState(root);
    if (s.workspaces) return s.workspaces;
    const map = new Map();
    const patterns = [];
    const pj = readJsonLoose(path.join(root, 'package.json'));
    if (pj && pj.workspaces) patterns.push(...(Array.isArray(pj.workspaces) ? pj.workspaces : (pj.workspaces.packages || [])));
    const pw = readText(path.join(root, 'pnpm-workspace.yaml'));
    if (pw) {
        const m = pw.match(/^packages:\s*\n((?:\s+-\s+.*\n?)+)/m);
        if (m) for (const l of m[1].split('\n')) { const mm = l.match(/^\s+-\s+['"]?([^'"#\s]+)/); if (mm && !mm[1].startsWith('!')) patterns.push(mm[1]); }
    }
    for (const pat of patterns.slice(0, 40)) for (const d of expandWorkspaceGlob(root, pat)) {
        const p = readJsonLoose(path.join(d, 'package.json'));
        if (p && typeof p.name === 'string' && !map.has(p.name)) map.set(p.name, d);
    }
    s.workspaces = map;
    return map;
}
function nearestPackageDir(fromDir, root) {
    for (let d = fromDir; d.startsWith(root); d = path.dirname(d)) {
        if (isFile(path.join(d, 'package.json'))) return d;
        if (d === root) break;
    }
    return root;
}
// Alias table for the package that owns `fromDir`: [{prefix, targets:[abs dir/file base]}].
function aliasConfig(pkgDir, root) {
    const s = rootState(root);
    if (s.aliasConf.has(pkgDir)) return s.aliasConf.get(pkgDir);
    const aliases = [];
    const addAlias = (key, targets, base) => {
        const prefix = key.replace(/\/?\*$/, '');
        if (!prefix) return;
        const ts = (Array.isArray(targets) ? targets : [targets]).filter(t => typeof t === 'string').map(t => path.resolve(base, t.replace(/\/?\*$/, '')));
        if (ts.length) aliases.push({ prefix, targets: ts, exact: !/\*$/.test(key) });
    };
    // tsconfig / jsconfig `paths` — follow `extends` up to 3 hops for paths/baseUrl.
    for (const name of ['tsconfig.json', 'jsconfig.json']) {
        let file = path.join(pkgDir, name), seen = 0, baseDir = pkgDir, baseUrl = null;
        while (file && isFile(file) && seen++ < 4) {
            const cfg = readJsonLoose(file); if (!cfg) break;
            const co = cfg.compilerOptions || {};
            if (co.baseUrl && !baseUrl) baseUrl = path.resolve(path.dirname(file), co.baseUrl);
            if (co.paths) { const base = baseUrl || path.dirname(file); for (const [k, v] of Object.entries(co.paths)) addAlias(k, v, base); break; }
            file = typeof cfg.extends === 'string' && cfg.extends.startsWith('.') ? path.resolve(path.dirname(file), cfg.extends) : null;
            if (file && !isFile(file) && isFile(file + '.json')) file += '.json';
        }
        if (aliases.length) break;
    }
    // svelte.config.js / vite.config.* `alias: { $lib: 'src/lib', '@': path.resolve(__dirname, 'src') }`
    for (const name of ['svelte.config.js', 'svelte.config.ts', 'vite.config.ts', 'vite.config.js', 'vite.config.mts', 'nuxt.config.ts']) {
        const t = readText(path.join(pkgDir, name)); if (!t) continue;
        const m = t.match(/\balias\s*:\s*\{([\s\S]*?)\n\s*\}/); if (!m) continue;
        for (const mm of m[1].matchAll(/['"]?([$@~][\w/-]*|[\w-]+)['"]?\s*:\s*(?:['"]([^'"]+)['"]|(?:path\.)?resolve\([^)]*?['"]([^'"]+)['"]\s*\)|fileURLToPath\(new URL\(['"]([^'"]+)['"])/g)) {
            const target = mm[2] || mm[3] || mm[4]; if (!target) continue;
            addAlias(mm[1], target.replace(/^\.\//, ''), pkgDir);
        }
    }
    s.aliasConf.set(pkgDir, aliases);
    return aliases;
}
const RESOLVE_EXTS = ['', '.tsx', '.ts', '.jsx', '.js', '.mjs', '.vue', '.svelte', '.astro'];
function tryBases(bases) {
    for (const b of bases) {
        for (const e of RESOLVE_EXTS) if (isFile(b + e)) return b + e;
        for (const e of RESOLVE_EXTS.slice(1)) if (isFile(path.join(b, 'index' + e))) return path.join(b, 'index' + e);
    }
    return null;
}
function resolveModule(src, fromDir, root) {
    if (!src || /^(?:node:|https?:)/.test(src)) return null;
    if (src.startsWith('.')) return tryBases([path.resolve(fromDir, src)]);
    if (src.startsWith('/')) return tryBases([path.join(root, src)]);
    const pkgDir = nearestPackageDir(fromDir, root);
    // 1. declared aliases of the owning package (longest prefix first)
    const aliases = aliasConfig(pkgDir, root).slice().sort((a, b) => b.prefix.length - a.prefix.length);
    for (const a of aliases) {
        if (a.exact ? src === a.prefix : (src === a.prefix || src.startsWith(a.prefix + '/') || (a.prefix.endsWith('/') && src.startsWith(a.prefix)))) {
            const rest = src === a.prefix ? '' : src.slice(a.prefix.length).replace(/^\//, '');
            const hit = tryBases(a.targets.map(t => rest ? path.join(t, rest) : t));
            if (hit) return hit;
        }
    }
    // 2. conventional aliases relative to the owning package
    if (src.startsWith('@/') || src.startsWith('~/')) {
        const rest = src.slice(2);
        const hit = tryBases(['src', 'app', 'resources/js', ''].map(pre => path.join(pkgDir, pre, rest)));
        if (hit) return hit;
    }
    if (src.startsWith('$lib/') || src === '$lib') return tryBases([path.join(pkgDir, 'src/lib', src.slice(4).replace(/^\//, ''))]);
    // 3. workspace packages: "@scope/pkg/sub" / "pkg/sub" → the package dir (honouring
    //    an exact `exports` entry), then <pkg>/sub and <pkg>/src/sub.
    const ws = workspacePackages(root);
    if (ws.size) {
        const segs = src.split('/');
        const name = src.startsWith('@') ? segs.slice(0, 2).join('/') : segs[0];
        const dir = ws.get(name);
        if (dir) {
            const sub = src.slice(name.length).replace(/^\//, '');
            const pj = readJsonLoose(path.join(dir, 'package.json')) || {};
            const ex = pj.exports && pj.exports['.' + (sub ? '/' + sub : '')];
            const exTarget = typeof ex === 'string' ? ex : (ex && typeof ex === 'object' ? (ex.import || ex.default || ex.types) : null);
            if (typeof exTarget === 'string' && !/\/dist\//.test(exTarget) && isFile(path.join(dir, exTarget))) return path.join(dir, exTarget);
            const hit = tryBases(sub ? [path.join(dir, sub), path.join(dir, 'src', sub)] : [path.join(dir, 'src'), dir]);
            if (hit) return hit;
        }
    }
    return null;
}
// A barrel (`index.ts` of re-exports) is where an alias/workspace import lands;
// the piece that renders is the module it re-exports. Follow `export { Name }
// from './x'` and `export * from './x'` for the imported name, two hops at most.
function followBarrel(file, name, root, hop = 0) {
    if (!file || !name || hop > 2) return file;
    const text = readText(file);
    if (!text || !/\bexport\s+(?:\{|\*)/.test(text)) return file;
    // The module defines the name itself: it is the piece.
    if (new RegExp('(?:^|\\n)\\s*export\\s+(?:default\\s+)?(?:const|let|var|function|class|async function)\\s+' + name + '\\b').test(text)) return file;
    const dir = path.dirname(file);
    for (const m of text.matchAll(/export\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
        const names = m[1].split(',').map(x => x.trim().split(/\s+as\s+/).pop().trim());
        if (names.includes(name)) { const t = resolveModule(m[2], dir, root); return t ? followBarrel(t, name, root, hop + 1) : file; }
    }
    let seen = 0;
    for (const m of text.matchAll(/export\s*\*\s*from\s*['"]([^'"]+)['"]/g)) {
        if (seen++ > 12) break;
        const t = resolveModule(m[1], dir, root);
        if (!t) continue;
        const tt = readText(t) || '';
        if (new RegExp('\\b' + name + '\\b').test(tt)) return followBarrel(t, name, root, hop + 1);
    }
    return file;
}
// Angular: `<pngx-widget>` → the component whose decorator declares that selector.
// One bounded walk per package (component .ts files under src/), cached.
function angularSelectorMap(pkgDir, root) {
    const s = rootState(root);
    if (!s.selectors) s.selectors = new Map();
    if (s.selectors.has(pkgDir)) return s.selectors.get(pkgDir);
    const map = new Map();
    const start = isFile(path.join(pkgDir, 'src', 'main.ts')) || fs.existsSync(path.join(pkgDir, 'src', 'app')) ? path.join(pkgDir, 'src') : pkgDir;
    let budget = 4000;
    const walk = d => {
        if (budget <= 0) return;
        let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
            if (budget-- <= 0) return;
            const p = path.join(d, e.name);
            if (e.isDirectory()) { if (!/^(?:node_modules|dist|\.angular|\.git|coverage)$/.test(e.name)) walk(p); continue; }
            if (!/\.component\.ts$/.test(e.name)) continue;
            const t = readText(p); if (!t) continue;
            const m = t.match(/selector\s*:\s*['"`]([^'"`]+)['"`]/); if (!m) continue;
            const tu = t.match(/templateUrl\s*:\s*['"`]([^'"`]+)['"`]/);
            const html = tu ? path.resolve(path.dirname(p), tu[1]) : p.replace(/\.ts$/, '.html');
            for (const sel of m[1].split(',')) map.set(sel.trim().replace(/^\[|\]$/g, ''), isFile(html) ? html : p);
        }
    };
    walk(start);
    s.selectors.set(pkgDir, map);
    return map;
}
const UI_PRIMITIVES = new Set(('Button Icon Tooltip Dialog Link Input Select Form Label Badge Avatar Skeleton Trans Head Meta Fragment Suspense ' +
    'Provider Image Img Text Box Flex Grid Stack Card Container Divider Spinner Loader Portal Popover Menu MenuItem DropdownMenu Checkbox Switch ' +
    'Radio Textarea TextField Alert Toast Modal Sheet Tabs Tab Table Th Td Tr Slot Transition Motion ErrorBoundary Script Layout Component Title ' +
    'Description Separator Toaster Helmet Router Routes Route Outlet NavLink Anchor Heading Paragraph Span Center Group Row Col Column Section Main ' +
    'Header Footer Nav Aside Article Wrapper Root Content Trigger Item List ListItem Field FormField FormItem FormLabel FormControl FormMessage Kbd Code Pre Strong Em Small').split(' '));
const PRIMITIVE_SUFFIX_RE = /(?:Provider|Context|Boundary|Icon|Trigger|Portal|Props|Params|Button|Link)$/;
const ICON_PREFIX_RE = /^(?:Icon|Lucide|Tabler|Fa|Md|Hi|Bi|Ri|Io)[A-Z]/;

/**
 * Every include reference in `relFile` with {name, file (repo-relative or null),
 * line, guarded, overlay}. `guarded` = a template guard on the same line or within
 * the 3 lines above; `overlay` = the include's name/file or its surrounding element
 * reads as an overlay.
 */
function includeRefs(root, relFile) {
    const abs = path.join(root, relFile);
    const text = readText(abs);
    if (!text) return [];
    const dir = path.dirname(abs);
    const rel = p => path.relative(root, p).split(path.sep).join('/');
    const lines = text.split('\n');
    const lineOf = idx => text.slice(0, idx).split('\n').length;
    const refs = new Map();
    const add = (name, file, idx) => {
        if (refs.has(name)) return;
        const ln = lineOf(idx);
        const ctx = lines.slice(Math.max(0, ln - 4), ln).join('\n');
        // Overlay-ness from the include's own line and the line above (an opening
        // wrapper like <div class="modal"> / role="dialog"); no further, or a
        // neighbouring overlay would taint an unrelated include.
        const around = lines.slice(Math.max(0, ln - 2), ln).join('\n');
        refs.set(name, {
            name, file: file ? rel(file) : null, line: ln,
            guarded: guardOpen(ctx),
            overlay: OVERLAY_NAME_RE.test(name) || (file && OVERLAY_NAME_RE.test(path.basename(file))) || OVERLAY_ATTR_RE.test(around),
        });
    };
    const ext = path.extname(relFile).toLowerCase();
    if (['.tsx', '.jsx', '.js', '.ts', '.mjs', '.vue', '.svelte', '.astro'].includes(ext)) {
        const imports = new Map();
        for (const m of text.matchAll(/import\s+(?:type\s+)?(?:(\w+)|\{([^}]*)\}|(\w+)\s*,\s*\{([^}]*)\})\s+from\s+['"]([^'"]+)['"]/g)) {
            const names = [];
            if (m[1]) names.push(m[1]);
            if (m[3]) names.push(m[3]);
            for (const g of [m[2], m[4]]) if (g) for (const part of g.split(',')) { const n = part.trim().split(/\s+as\s+/).pop().trim(); if (n) names.push(n); }
            for (const n of names) imports.set(n, m[5]);
        }
        for (const m of text.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*(?:React\.)?lazy\(\s*(?:async\s*)?\(\)\s*=>\s*import\(\s*['"]([^'"]+)['"]/g)) if (!imports.has(m[1])) imports.set(m[1], m[2]);
        for (const m of text.matchAll(/(?<![A-Za-z0-9_$\])])<([A-Z][A-Za-z0-9]*)(?:\.[A-Z][A-Za-z0-9]*)*(?=[\s/>])/g)) {
            const name = m[1];
            if (UI_PRIMITIVES.has(name) || PRIMITIVE_SUFFIX_RE.test(name) || ICON_PREFIX_RE.test(name)) continue;
            const src = imports.get(name);
            // Defined in this very file (a local sub-component): not an include.
            if (!src && new RegExp('(?:^|\\n)\\s*(?:export\\s+)?(?:const|let|var|function|class)\\s+' + name + '\\b').test(text)) continue;
            add(name, src ? followBarrel(resolveModule(src, dir, root), name, root) : null, m.index);
        }
    }
    if (/\.(?:erb|haml|slim)$/.test(ext) || ext === '.rb') {
        for (const m of text.matchAll(/render\s*\(?\s*(?:partial:\s*)?['"]([\w\/.-]+)['"]/g)) {
            const name = m[1]; let file = null;
            const base = name.split('/').pop();
            const viewsRoot = abs.includes('/app/views/') ? abs.slice(0, abs.indexOf('/app/views/') + '/app/views/'.length) : null;
            // "shared/x" resolves against the views root when known, else against the
            // view's dir and its parent (a bare "x" is a sibling partial).
            const dirs = name.includes('/')
                ? [viewsRoot && path.join(viewsRoot, path.dirname(name)), path.join(dir, path.dirname(name)), path.join(path.dirname(dir), path.dirname(name))].filter(Boolean)
                : [dir];
            outer: for (const d of dirs) for (const e of ['.html.erb', '.erb', '.html.haml', '.html.slim', '.turbo_stream.erb']) {
                const p = path.join(d, `_${base}${e}`); if (isFile(p)) { file = p; break outer; }
            }
            add(name, file, m.index);
        }
        for (const m of text.matchAll(/render\s*\(?\s*([A-Z][A-Za-z0-9:]*Component)\.new/g)) {
            const snake = m[1].replace(/::/g, '/').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
            add(m[1], findUnder(root, ['app/components'], `${snake}.html.erb`) || findUnder(root, ['app/components'], `${snake}.rb`), m.index);
        }
    }
    if (ext === '.php' && /\.blade\.php$/.test(relFile)) {
        for (const m of text.matchAll(/@include(?:If|When|Unless)?\(\s*(?:[^,]+,\s*)?['"]([\w.-]+)['"]/g)) add(m[1], findUnder(root, ['resources/views'], m[1].replace(/\./g, '/') + '.blade.php'), m.index);
        for (const m of text.matchAll(/<x-([\w.-]+)[\s/>]/g)) add(`x-${m[1]}`, findUnder(root, ['resources/views/components'], m[1].replace(/\./g, '/') + '.blade.php'), m.index);
        for (const m of text.matchAll(/<livewire:([\w.-]+)[\s/>]/g)) add(`livewire:${m[1]}`, findUnder(root, ['resources/views/livewire'], m[1].replace(/\./g, '/') + '.blade.php'), m.index);
    }
    if (ext === '.php' && !/\.blade\.php$/.test(relFile)) {
        for (const m of text.matchAll(/\b(?:require|include)(?:_once)?\s*\(?\s*(?:ABSPATH\s*\.\s*)?['"]([\w\/.-]+\.php)['"]/g)) {
            const p = isFile(path.join(root, m[1])) ? path.join(root, m[1]) : (isFile(path.join(dir, m[1])) ? path.join(dir, m[1]) : null);
            add(m[1], p, m.index);
        }
        for (const m of text.matchAll(/\bget_template_part\(\s*['"]([\w\/.-]+)['"]/g)) add(m[1], null, m.index);
    }
    for (const m of text.matchAll(/\{%-?\s*(?:include|embed)\s+['"]([\w\/.-]+)['"]/g)) {
        let p = null;
        for (let d = dir; d.startsWith(root) && !p; d = path.dirname(d)) {
            if (isFile(path.join(d, m[1]))) p = path.join(d, m[1]);
            else if (isFile(path.join(d, 'templates', m[1]))) p = path.join(d, 'templates', m[1]);
            if (d === root) break;
        }
        add(m[1], p, m.index);
    }
    if (ext === '.cshtml') {
        for (const m of text.matchAll(/(?:<partial\s+name\s*=\s*["']([\w.-]+)["']|Partial(?:Async)?\(\s*["']([\w.-]+)["'])/g)) {
            const name = m[1] || m[2];
            add(name, findUnder(root, [rel(dir), 'Views/Shared', 'Areas/Admin/Views/Shared', 'Pages/Shared'], `${name}.cshtml`), m.index);
        }
    }
    if (ext === '.html' || ext === '.heex' || ext === '.eex') {
        const selectors = ext === '.html' ? angularSelectorMap(nearestPackageDir(dir, root), root) : new Map();
        for (const m of text.matchAll(/<(app-[a-z0-9-]+|[a-z][a-z0-9]*-[a-z0-9-]+)[\s/>]/g)) {
            if (/^(?:ng-|router-|mat-|cdk-|nz-|p-|i-bs|ion-)/.test(m[1]) && !selectors.has(m[1])) continue;
            add(m[1], selectors.get(m[1]) || null, m.index);
        }
        for (const m of text.matchAll(/<\.([a-z_][a-z0-9_]*)[\s/>]/g)) add(`.${m[1]}`, null, m.index);
        for (const m of text.matchAll(/<([A-Z][\w.]*\.[a-z_][a-z0-9_]*)[\s/>]/g)) add(m[1], null, m.index);
    }
    return [...refs.values()];
}

/**
 * The census of a primary view: its own inline sections plus each include with
 * its render condition and marker strings.
 *   {
 *     inline_sections: [{heading, markers}],      // h1–h4 / legend blocks written directly in the view
 *     includes: [{name, file, line, kind: 'unconditional'|'overlay'|'conditional', markers}],
 *   }
 * `markers` are only taken from resolvable files; an include with no file has
 * `markers: []` and is reported but not checkable.
 */
function census(root, primaryView, opts = {}) {
    const text = readText(path.join(root, primaryView));
    const out = { inline_sections: [], includes: [] };
    if (!text) return out;
    // Inline sections: headings the view itself paints, with the markers that follow each until the next heading.
    const heads = [...text.matchAll(/<(h[1-4]|legend)\b[^>]*>([\s\S]{0,200}?)<\/\1>/gi)];
    for (let i = 0; i < heads.length; i++) {
        const heading = cleanMarker(heads[i][2]);
        if (!heading) continue;
        const start = heads[i].index; const end = i + 1 < heads.length ? heads[i + 1].index : Math.min(text.length, start + 6000);
        const before = text.slice(Math.max(0, start - 400), start);
        out.inline_sections.push({ heading, guarded: guardOpen(before.split('\n').slice(-4).join('\n')), markers: extractMarkers(text.slice(start, end)).slice(0, 12) });
    }
    for (const ref of includeRefs(root, primaryView)) {
        if (ref.file && SKIP_EXT_RE.test(ref.file)) continue;
        const kind = ref.overlay ? 'overlay' : (ref.guarded ? 'conditional' : 'unconditional');
        const markers = ref.file ? extractMarkers(readText(path.join(root, ref.file))).slice(0, 12) : [];
        out.includes.push({ name: ref.name, file: ref.file, line: ref.line, kind, markers });
    }
    return out;
}

module.exports = { census, includeRefs, extractMarkers, cleanMarker, guardOpen, resolveModule, followBarrel, workspacePackages, OVERLAY_NAME_RE, GUARD_RE };
