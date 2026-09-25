#!/usr/bin/env node
/**
 * resolve_route_chains.js — fill route_index[*].render_chain deterministically.
 *
 * Why: on component-tree apps (React/Svelte/Next monorepos) the screen behind a
 * route is 30–50 files deep, and the route index the model writes in STEP 4.6
 * records only the primary view. Every article run then rediscovers the chain
 * by grepping the repo (twenty: 270 bash reads, 16 min to the first image).
 * The chain is static per commit, so it belongs in the cache.
 *
 * What: for every route_index entry with a resolvable `primary_view`, walk the
 * include tree with the article skill's include census (shared module —
 * ERB/ViewComponent, JSX/Vue/Svelte, Blade/Livewire, Django/Jinja/Twig, Razor,
 * Phoenix/Angular, PHP requires) recursively, and write
 *
 *   render_chain: [{file, via, depth, kind}]      kind ∈ unconditional|overlay|conditional
 *   render_chain_stats: {files, unresolved, max_depth, truncated}
 *
 * plus `partials_expanded` when the entry has none (the unconditional files, in
 * discovery order — the field the article skill already consumes). Existing
 * `partials_expanded` values are never overwritten. Unresolvable references
 * (bare package imports, dynamic includes) are counted, not invented.
 *
 * Usage: resolve_route_chains.js <project_map.json> <project_dir> [--max-files N] [--max-depth N] [--json <report>]
 * Exit 0 always (a cache enrichment must never fail a detect); prints a summary.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const census = require('./include_census.js');

const MAX_FILES = 80;
const MAX_DEPTH = 6;
const SKIP_EXT_RE = /\.(?:json|ya?ml|arb|po|css|scss|sass|less|svg|png|jpe?g|gif|webp|ico|woff2?|ttf|md|txt|lock|d\.ts)$/i;
const SKIP_PATH_RE = /(?:^|\/)(?:node_modules|vendor|dist|build|\.next|\.svelte-kit|test|tests|__tests__|spec|stories?)\//;

function resolveChain(root, primaryView, maxFiles, maxDepth) {
    const chain = [];
    const seen = new Set([primaryView]);
    let unresolved = 0, truncated = false, maxSeen = 0;
    // BFS so the shallow, always-rendered pieces come first and a cap cuts the deep tail.
    const queue = [{ file: primaryView, depth: 0, inherited: 'unconditional' }];
    while (queue.length) {
        const { file, depth, inherited } = queue.shift();
        if (depth >= maxDepth) continue;
        let refs;
        try { refs = census.includeRefs(root, file); } catch { continue; }
        for (const ref of refs) {
            if (!ref.file) { unresolved++; continue; }
            if (SKIP_EXT_RE.test(ref.file) || SKIP_PATH_RE.test(ref.file)) continue;
            if (seen.has(ref.file)) continue;
            if (chain.length >= maxFiles) { truncated = true; break; }
            seen.add(ref.file);
            // A piece inherits its parent's condition: an unconditional include of a
            // conditional include is conditional for the screen.
            let kind = ref.overlay ? 'overlay' : (ref.guarded ? 'conditional' : 'unconditional');
            if (inherited === 'overlay' && kind === 'unconditional') kind = 'overlay';
            if (inherited === 'conditional' && kind === 'unconditional') kind = 'conditional';
            chain.push({ file: ref.file, via: file, depth: depth + 1, kind });
            maxSeen = Math.max(maxSeen, depth + 1);
            queue.push({ file: ref.file, depth: depth + 1, inherited: kind });
        }
        if (truncated) break;
    }
    return { chain, stats: { files: chain.length, unresolved, max_depth: maxSeen, truncated } };
}

function main() {
    const args = process.argv.slice(2);
    const positional = args.filter(a => !a.startsWith('--'));
    const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
    const mapPath = positional[0];
    const root = path.resolve(positional[1] || process.cwd());
    const maxFiles = parseInt(opt('--max-files', MAX_FILES), 10) || MAX_FILES;
    const maxDepth = parseInt(opt('--max-depth', MAX_DEPTH), 10) || MAX_DEPTH;
    const reportPath = opt('--json', null);
    if (!mapPath || !fs.existsSync(mapPath)) {
        console.log('resolve_route_chains: usage: resolve_route_chains.js <project_map.json> <project_dir> [--max-files N] [--max-depth N] [--json report]');
        return 0;
    }
    let pm;
    try { pm = JSON.parse(fs.readFileSync(mapPath, 'utf8')); } catch (e) {
        console.log(`resolve_route_chains: project_map.json unreadable (${e.message}) — nothing changed`);
        return 0;
    }
    const ri = pm.route_index;
    if (!ri || typeof ri !== 'object' || Array.isArray(ri)) {
        console.log('resolve_route_chains: no route_index object — nothing to resolve');
        return 0;
    }
    const report = { resolved: 0, skipped: 0, total_files: 0, routes: {}, layouts: {} };
    const readable = p => { try { return !!p && fs.statSync(path.join(root, p)).isFile(); } catch { return false; } };
    for (const [key, entry] of Object.entries(ri)) {
        if (!entry || typeof entry !== 'object') { report.skipped++; continue; }
        let pv = typeof entry.primary_view === 'string' ? entry.primary_view.replace(/^\/+/, '') : null;
        if (!pv && typeof entry.controller === 'string' && /^[\w/]+#\w+$/.test(entry.controller)) {
            // Rails convention: `things#index` renders app/views/things/index.html.erb
            // unless the action says otherwise; recorded as the derivation it is.
            const [ctrl, action] = entry.controller.split('#');
            for (const ext of ['.html.erb', '.html.haml', '.html.slim']) {
                const cand = `app/views/${ctrl}/${action}${ext}`;
                if (readable(cand)) { pv = cand; entry.primary_view = cand; entry.primary_view_source = 'convention'; break; }
            }
        }
        if (!readable(pv)) { report.skipped++; continue; }
        const { chain, stats } = resolveChain(root, pv, maxFiles, maxDepth);
        entry.render_chain = chain;
        entry.render_chain_stats = stats;
        if (!Array.isArray(entry.partials_expanded) || !entry.partials_expanded.length) {
            entry.partials_expanded = chain.filter(c => c.kind === 'unconditional').map(c => c.file);
        }
        report.routes[key] = { primary_view: pv, ...stats };
        report.resolved++; report.total_files += stats.files;
    }
    // The recorded layouts are the shell: resolve their chains once too, so a run
    // opens the shell's real files instead of re-deriving them from `chrome`.
    if (Array.isArray(pm.layouts)) for (const lay of pm.layouts) {
        const lp = lay && typeof lay.path === 'string' ? lay.path.replace(/^\/+/, '') : null;
        if (!readable(lp)) continue;
        const { chain, stats } = resolveChain(root, lp, maxFiles, maxDepth);
        lay.render_chain = chain; lay.render_chain_stats = stats;
        report.layouts[lay.name || lp] = { path: lp, ...stats };
    }
    pm.route_chain_resolver = { version: 1, generated_at: new Date().toISOString(), max_files: maxFiles, max_depth: maxDepth };
    fs.writeFileSync(mapPath, JSON.stringify(pm, null, 2) + '\n');
    if (reportPath) fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
    const deep = Object.entries(report.routes).filter(([, s]) => s.files >= 10).length;
    const layN = Object.keys(report.layouts).length;
    console.log(`resolve_route_chains: ${report.resolved} route(s) resolved (${report.total_files} chain files, ${deep} route(s) with ≥10), ${report.skipped} skipped (no readable primary_view); ${layN} layout chain(s)`);
    return 0;
}

if (require.main === module) process.exitCode = main();
module.exports = { resolveChain };
