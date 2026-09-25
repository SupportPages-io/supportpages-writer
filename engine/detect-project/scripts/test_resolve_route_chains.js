#!/usr/bin/env node
/**
 * resolve_route_chains.js + the census resolver on a synthetic monorepo:
 * tsconfig `paths` (JSONC, alias keys containing "/*"), a workspace package
 * with `exports` + a barrel, a locally-defined sub-component, SvelteKit `$lib`,
 * an Angular selector, the Rails controller→view convention, layout chains,
 * kind inheritance, `partials_expanded` fill-without-overwrite, exit 0 on
 * missing input.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'resolve_route_chains.js');
const census = require('./include_census.js');

function write(root, rel, text) { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); }
function run(mapPath, root, extra = []) {
    return execFileSync('node', [SCRIPT, mapPath, root, ...extra], { encoding: 'utf8' });
}

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rrc-'));
    write(root, 'package.json', JSON.stringify({ name: 'mono', workspaces: ['apps/*', 'packages/*'] }));
    // apps/web — JSONC tsconfig whose alias key carries "/*" (a regex stripper would eat it)
    write(root, 'apps/web/package.json', JSON.stringify({ name: '@mono/web' }));
    write(root, 'apps/web/tsconfig.json', `{
  /* base */
  "compilerOptions": {
    "baseUrl": ".", // comment after
    "paths": { "~/*": ["modules/*"], "@ui/*": ["../../packages/ui/src/*"] },
  },
  "include": ["**/*.ts", "**/*.tsx"],
}`);
    write(root, 'apps/web/app/things/page.tsx', `import Shell from "~/shell/Shell";
import { DataTable, StatusBadge } from "@mono/ui/components/table";
import { HeaderBar } from "@ui/HeaderBar";
import { FancyModal } from "@mono/ui/components/modal";
const LocalRow = () => <tr><td>local</td></tr>;
export default function Page({ admin }) {
  return (<Shell>
    <HeaderBar />
    <DataTable><LocalRow /><StatusBadge /></DataTable>
    {admin && <AdminPanel />}
    <FancyModal />
  </Shell>);
}
import { AdminPanel } from "~/admin/AdminPanel";
`);
    write(root, 'apps/web/modules/shell/Shell.tsx', `import { SideNav } from "~/shell/SideNav";
export default function Shell({ children }) { return <div><SideNav /><main>{children}</main></div>; }`);
    write(root, 'apps/web/modules/shell/SideNav.tsx', `export const SideNav = () => <nav><a>Things</a></nav>;`);
    write(root, 'apps/web/modules/admin/AdminPanel.tsx', `import { DangerZone } from "~/admin/DangerZone";
export const AdminPanel = () => <section><DangerZone /></section>;`);
    write(root, 'apps/web/modules/admin/DangerZone.tsx', `export const DangerZone = () => <p>danger</p>;`);
    write(root, 'apps/web/app/layout.tsx', `import Shell from "~/shell/Shell";
export default function L({ children }) { return <Shell>{children}</Shell>; }`);
    // packages/ui — workspace package with exports + barrel
    write(root, 'packages/ui/package.json', JSON.stringify({ name: '@mono/ui', exports: { './components/table': './components/table/index.ts', './components/modal': './components/modal/index.ts' } }));
    write(root, 'packages/ui/components/table/index.ts', `export { DataTable } from "./DataTable";\nexport * from "./StatusBadge";`);
    write(root, 'packages/ui/components/table/DataTable.tsx', `export const DataTable = ({ children }) => <table>{children}</table>;`);
    write(root, 'packages/ui/components/table/StatusBadge.tsx', `export const StatusBadge = () => <span/>;`);
    write(root, 'packages/ui/components/modal/index.ts', `export { FancyModal } from "./FancyModal";`);
    write(root, 'packages/ui/components/modal/FancyModal.tsx', `import { ModalFooter } from "./ModalFooter";\nexport const FancyModal = () => <div role="dialog"><ModalFooter/></div>;`);
    write(root, 'packages/ui/components/modal/ModalFooter.tsx', `export const ModalFooter = () => <footer/>;`);
    write(root, 'packages/ui/src/HeaderBar.tsx', `export const HeaderBar = () => <header>Things</header>;`);
    // apps/kit — SvelteKit with $lib
    write(root, 'apps/kit/package.json', JSON.stringify({ name: '@mono/kit' }));
    write(root, 'apps/kit/src/routes/albums/+page.svelte', `<script>\n  import Albums from '$lib/components/Albums.svelte';\n</script>\n<Albums />`);
    write(root, 'apps/kit/src/lib/components/Albums.svelte', `<ul><li>Album</li></ul>`);
    // apps/ng — Angular selectors
    write(root, 'apps/ng/package.json', JSON.stringify({ name: '@mono/ng' }));
    write(root, 'apps/ng/src/main.ts', ``);
    write(root, 'apps/ng/src/app/dash/dash.component.html', `<pngx-page-header></pngx-page-header>\n<ng-container></ng-container>\n<pngx-stats-widget />`);
    write(root, 'apps/ng/src/app/common/page-header/page-header.component.ts', `@Component({ selector: 'pngx-page-header', templateUrl: './page-header.component.html' })\nexport class PageHeaderComponent {}`);
    write(root, 'apps/ng/src/app/common/page-header/page-header.component.html', `<h1>Header</h1>`);
    write(root, 'apps/ng/src/app/dash/widgets/stats/stats.component.ts', `@Component({ selector: 'pngx-stats-widget', templateUrl: './stats.component.html' })\nexport class StatsComponent {}`);
    write(root, 'apps/ng/src/app/dash/widgets/stats/stats.component.html', `<p>Stats</p>`);
    // Rails convention
    write(root, 'app/views/things/index.html.erb', `<%= render "layouts/header" %>\n<h1>Things</h1>`);
    write(root, 'app/views/layouts/_header.html.erb', `<header/>`);
    const map = {
        route_index: {
            things: { method: 'GET', path: '/things', primary_view: 'apps/web/app/things/page.tsx', layout: 'root' },
            albums: { method: 'GET', path: '/albums', primary_view: 'apps/kit/src/routes/albums/+page.svelte', partials_expanded: ['already/listed.svelte'] },
            dash: { method: 'GET', path: '/dash', primary_view: 'apps/ng/src/app/dash/dash.component.html' },
            rails_things: { method: 'GET', path: '/rails/things', controller: 'things#index' },
            ghost: { method: 'GET', path: '/ghost', primary_view: 'apps/web/app/missing.tsx' },
        },
        layouts: [{ name: 'root', path: 'apps/web/app/layout.tsx', chrome: [] }],
    };
    const mapPath = path.join(root, 'project_map.json');
    fs.writeFileSync(mapPath, JSON.stringify(map, null, 2));
    return { root, mapPath };
}

// ── resolver unit checks ────────────────────────────────────────────────────
{
    const { root } = fixture();
    const from = path.join(root, 'apps/web/app/things');
    assert.strictEqual(census.resolveModule('~/shell/Shell', from, root), path.join(root, 'apps/web/modules/shell/Shell.tsx'), 'tsconfig paths alias (JSONC with "/*" keys)');
    assert.strictEqual(census.resolveModule('@ui/HeaderBar', from, root), path.join(root, 'packages/ui/src/HeaderBar.tsx'), 'alias into a sibling package');
    assert.strictEqual(census.resolveModule('@mono/ui/components/table', from, root), path.join(root, 'packages/ui/components/table/index.ts'), 'workspace package exports entry');
    assert.strictEqual(census.followBarrel(census.resolveModule('@mono/ui/components/table', from, root), 'DataTable', root), path.join(root, 'packages/ui/components/table/DataTable.tsx'), 'barrel export { X } from');
    assert.strictEqual(census.followBarrel(census.resolveModule('@mono/ui/components/table', from, root), 'StatusBadge', root), path.join(root, 'packages/ui/components/table/StatusBadge.tsx'), 'barrel export * from');
    assert.strictEqual(census.resolveModule('react', from, root), null, 'bare external stays unresolved');
    const refs = census.includeRefs(root, 'apps/web/app/things/page.tsx');
    const byName = Object.fromEntries(refs.map(r => [r.name, r]));
    assert(!('LocalRow' in byName), 'a component defined in the same file is not an include');
    assert.strictEqual(byName.Shell.file, 'apps/web/modules/shell/Shell.tsx');
    assert.strictEqual(byName.AdminPanel.guarded, true, '&& guard');
    assert.strictEqual(byName.FancyModal.overlay, true, 'modal by name');
    const ng = Object.fromEntries(census.includeRefs(root, 'apps/ng/src/app/dash/dash.component.html').map(r => [r.name, r]));
    assert.strictEqual(ng['pngx-page-header'].file, 'apps/ng/src/app/common/page-header/page-header.component.html', 'angular selector → template');
    assert.strictEqual(ng['pngx-stats-widget'].file, 'apps/ng/src/app/dash/widgets/stats/stats.component.html');
    assert(!('ng-container' in ng), 'framework tags skipped');
    fs.rmSync(root, { recursive: true, force: true });
}

// ── script end-to-end ───────────────────────────────────────────────────────
{
    const { root, mapPath } = fixture();
    const out = run(mapPath, root, ['--json', path.join(root, 'report.json')]);
    assert(/4 route\(s\) resolved/.test(out), out);
    assert(/1 skipped/.test(out), out);
    assert(/1 layout chain\(s\)/.test(out), out);
    const pm = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
    const things = pm.route_index.things;
    const files = things.render_chain.map(c => c.file);
    const kind = f => things.render_chain.find(c => c.file === f).kind;
    assert(files.includes('apps/web/modules/shell/Shell.tsx'), 'alias import in chain');
    assert(files.includes('apps/web/modules/shell/SideNav.tsx'), 'depth-2 through the alias');
    assert(files.includes('packages/ui/components/table/DataTable.tsx'), 'barrel followed to the component');
    assert(files.includes('packages/ui/components/table/StatusBadge.tsx'), 'export * barrel followed');
    assert(!files.includes('packages/ui/components/table/index.ts'), 'the barrel itself is not a chain file');
    assert.strictEqual(kind('apps/web/modules/admin/AdminPanel.tsx'), 'conditional');
    assert.strictEqual(kind('apps/web/modules/admin/DangerZone.tsx'), 'conditional', 'inherits the parent guard');
    assert.strictEqual(kind('packages/ui/components/modal/FancyModal.tsx'), 'overlay');
    assert.strictEqual(kind('packages/ui/components/modal/ModalFooter.tsx'), 'overlay', 'inherits overlay-ness');
    assert.strictEqual(kind('apps/web/modules/shell/Shell.tsx'), 'unconditional');
    assert.deepStrictEqual(things.partials_expanded, things.render_chain.filter(c => c.kind === 'unconditional').map(c => c.file), 'partials_expanded filled from the unconditional chain');
    assert.strictEqual(things.render_chain_stats.files, things.render_chain.length);
    assert.strictEqual(things.render_chain_stats.truncated, false);
    assert(things.render_chain_stats.unresolved >= 0);
    assert.deepStrictEqual(pm.route_index.albums.partials_expanded, ['already/listed.svelte'], 'existing partials_expanded never overwritten');
    assert.deepStrictEqual(pm.route_index.albums.render_chain.map(c => c.file), ['apps/kit/src/lib/components/Albums.svelte'], '$lib resolves against the owning package');
    assert.deepStrictEqual(pm.route_index.dash.render_chain.map(c => c.file).sort(), ['apps/ng/src/app/common/page-header/page-header.component.html', 'apps/ng/src/app/dash/widgets/stats/stats.component.html'].sort(), 'angular chain');
    assert.strictEqual(pm.route_index.rails_things.primary_view, 'app/views/things/index.html.erb', 'rails convention fallback');
    assert.strictEqual(pm.route_index.rails_things.primary_view_source, 'convention');
    assert.deepStrictEqual(pm.route_index.rails_things.render_chain.map(c => c.file), ['app/views/layouts/_header.html.erb']);
    assert(!pm.route_index.ghost.render_chain, 'unreadable primary_view is skipped untouched');
    assert.deepStrictEqual(pm.layouts[0].render_chain.map(c => c.file), ['apps/web/modules/shell/Shell.tsx', 'apps/web/modules/shell/SideNav.tsx'], 'layout chain');
    assert.strictEqual(pm.route_chain_resolver.version, 1);
    const report = JSON.parse(fs.readFileSync(path.join(root, 'report.json'), 'utf8'));
    assert.strictEqual(report.resolved, 4); assert.strictEqual(report.skipped, 1);
    // caps
    const again = run(mapPath, root, ['--max-files', '2']);
    const capped = JSON.parse(fs.readFileSync(mapPath, 'utf8')).route_index.things;
    assert.strictEqual(capped.render_chain.length, 2); assert.strictEqual(capped.render_chain_stats.truncated, true);
    assert(again.includes('resolve_route_chains'));
    // idempotent re-run keeps partials_expanded from the first (uncapped) pass
    assert(capped.partials_expanded.length > 2, 'filled partials_expanded survives a re-run');
    fs.rmSync(root, { recursive: true, force: true });
}

// ── never fails a detect ────────────────────────────────────────────────────
{
    const out = run('/nonexistent/project_map.json', os.tmpdir());
    assert(/usage/.test(out));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rrc-'));
    const mp = path.join(root, 'project_map.json');
    fs.writeFileSync(mp, '{"framework":"rails"}');
    assert(/no route_index/.test(run(mp, root)));
    fs.writeFileSync(mp, '{not json');
    assert(/unreadable/.test(run(mp, root)));
    fs.rmSync(root, { recursive: true, force: true });
}

console.log('resolve_route_chains tests passed');
