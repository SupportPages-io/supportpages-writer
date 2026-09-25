#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const checker = path.join(__dirname, 'check_runtime_recipe_quality.js');
const profiles = path.join(__dirname, 'apply_runtime_profiles.js');
const coverage = path.join(__dirname, 'check_runtime_coverage.js');

function write(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
}

function files(root) {
    const values = {
        'views/editor.js': 'app.initializeEditor("editor", {});',
        'views/template.html': '<main>Blog Home</main>',
        'views/header.html': '<header>My Site</header>',
        'views/footer.html': '<footer>Designed with WordPress</footer>',
        'views/preview.webp': 'image',
    };
    for (const [rel, value] of Object.entries(values)) write(path.join(root, rel), value);
}

function strongMap() {
    const mount = ['views/editor.js'];
    const content = ['views/template.html', 'views/header.html', 'views/footer.html'];
    return {
        schema_version: 5,
        default_user_assumptions: ['JavaScript enabled'],
        app_shell: { root_classes: { html: ['with-toolbar'], body: ['app-shell'] } },
        runtime_surface_coverage: { ignored: [] },
        layouts: [{
            name: 'site-editor', path: 'views/editor.js', area: 'fullscreen editor with no classic toolbar', chrome: [],
            root_classes: { html: [], body: ['editor', 'is-fullscreen-mode'] },
            runtime_chrome: {
                app: 'Site editor', mode_note: 'Always fullscreen with the shell hidden.',
                source_kind: 'knowledge', source_files: mount,
                regions: [
                    { id: 'navigation', region: 'design navigation', placement: 'left', required: false,
                        appearance: 'dark #111 sidebar',
                        items: [{ id: 'identity', kind: 'identity', description: 'site identity', required_strings: [] },
                            { id: 'destinations', kind: 'navigation-list', description: 'destinations', required_strings: ['Styles', 'Templates'] }],
                        ui_strings: ['Styles', 'Templates'], required_strings: ['Styles'], source_files: mount },
                    { id: 'toolbar', region: 'editing toolbar', placement: 'top', required: false,
                        appearance: 'light full-width toolbar',
                        items: [{ id: 'identity', kind: 'identity', description: 'back identity', required_strings: [] },
                            { id: 'editing-tools', kind: 'control-group', description: 'editing controls', required_strings: [] },
                            { id: 'document-title', kind: 'document-context', description: 'document title', required_strings: ['Blog Home'] },
                            { id: 'view-tools', kind: 'control-group', description: 'view controls', required_strings: [] },
                            { id: 'save', kind: 'primary-action', description: 'save action', required_strings: ['Save'] }],
                        ui_strings: ['Blog Home', 'Save'], required_strings: ['Save'], source_files: mount },
                    { id: 'canvas', region: 'site canvas', placement: 'canvas', required: true,
                        appearance: 'largest white populated canvas', content_mode: 'populated', media_expectation: 'required',
                        representative_assets: ['views/preview.webp'], max_selected_outlines: 1,
                        items: [{ id: 'header', kind: 'content-section', description: 'header', required_strings: [] },
                            { id: 'main', kind: 'content-section', description: 'main content', required_strings: [] },
                            { id: 'footer', kind: 'content-section', description: 'footer', required_strings: ['Designed with WordPress'] }],
                        ui_strings: ['Designed with WordPress'], required_strings: ['Designed with WordPress'], source_files: content },
                    { id: 'styles-panel', region: 'styles inspector', placement: 'right', required: false,
                        appearance: 'light right sidebar',
                        items: [{ id: 'heading', kind: 'panel-heading', description: 'heading', required_strings: ['Styles'] },
                            { id: 'browse', kind: 'action-card', description: 'browse styles', required_strings: ['Browse styles'] },
                            { id: 'colors', kind: 'panel-row', description: 'colors row', required_strings: ['Colors'] },
                            { id: 'layout', kind: 'panel-row', description: 'layout row', required_strings: ['Layout'] }],
                        ui_strings: ['Styles', 'Browse styles', 'Colors', 'Layout'], required_strings: ['Styles'], source_files: mount },
                    { id: 'template-panel', region: 'template inspector', placement: 'right', required: false,
                        appearance: 'light right sidebar',
                        items: [{ id: 'heading', kind: 'panel-heading', description: 'heading', required_strings: ['Template'] },
                            { id: 'summary', kind: 'settings-list', description: 'summary', required_strings: ['Blog Home'] },
                            { id: 'header', kind: 'panel-row', description: 'header row', required_strings: ['Header'] },
                            { id: 'footer', kind: 'panel-row', description: 'footer row', required_strings: ['Footer'] }],
                        ui_strings: ['Template', 'Blog Home', 'Header', 'Footer'], required_strings: ['Template'], source_files: mount },
                    { id: 'confirm', region: 'save confirmation', placement: 'overlay-right', required: false,
                        appearance: 'light right overlay panel',
                        items: [{ id: 'heading', kind: 'panel-heading', description: 'heading', required_strings: ['Ready to save?'] },
                            { id: 'styles-group', kind: 'group-heading', description: 'styles group', required_strings: ['Styles'] },
                            { id: 'styles-change', kind: 'selection-row', description: 'theme change', required_strings: ['Example Theme'] },
                            { id: 'templates-group', kind: 'group-heading', description: 'templates group', required_strings: ['Templates'] },
                            { id: 'template-change', kind: 'selection-row', description: 'template change', required_strings: ['Blog Home'] },
                            { id: 'actions', kind: 'actions', description: 'actions', required_strings: ['Cancel', 'Save'] }],
                        ui_strings: ['Ready to save?', 'Styles', 'Templates', 'Cancel', 'Save'],
                        required_strings: ['Ready to save?', 'Cancel', 'Save'], source_files: mount },
                ],
                states: [
                    { id: 'overview', kind: 'overview', visible_regions: ['navigation', 'canvas'], required_regions: [],
                        screenshot_required: false, required_strings: ['Styles'], source_files: content },
                    { id: 'styles-editing', kind: 'action', context_label: 'Blog Home', visible_regions: ['toolbar', 'canvas', 'styles-panel'],
                        required_regions: ['toolbar', 'styles-panel'], screenshot_required: false, required_strings: ['Blog Home'], source_files: content },
                    { id: 'template-editing', kind: 'action', context_label: 'Blog Home', visible_regions: ['toolbar', 'canvas', 'template-panel'],
                        required_regions: ['toolbar', 'template-panel'], screenshot_required: false, required_strings: ['Blog Home'], source_files: content },
                    { id: 'confirm-save', kind: 'confirm', context_label: 'Blog Home', visible_regions: ['toolbar', 'canvas', 'confirm'],
                        required_regions: ['confirm'], screenshot_required: true, required_strings: ['Blog Home', 'Save'], source_files: content },
                ],
            },
        }],
        route_index: { editor: { path: '/editor', controller: 'views/editor.js', primary_view: 'views/editor.js',
            controller_action: 'views/editor.js', layout: 'site-editor', partials_expanded: content } },
    };
}

function runQuality(mutator = () => {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rtfm-runtime-quality-'));
    files(root);
    const map = strongMap();
    mutator(map, root);
    const mapPath = path.join(root, 'project_map.json');
    write(mapPath, map);
    const reportPath = path.join(root, 'report.json');
    const proc = spawnSync(process.execPath, [checker, mapPath, root, '--json', reportPath], { encoding: 'utf8' });
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    fs.rmSync(root, { recursive: true, force: true });
    return { proc, report };
}

let result = runQuality();
assert.strictEqual(result.proc.status, 0, result.proc.stderr);

result = runQuality(map => { map.layouts[0].runtime_chrome.regions.find(region => region.id === 'canvas').items.length = 1; });
assert.strictEqual(result.proc.status, 1);
assert(result.report.errors.some(error => error.includes('three source-backed anatomy items')));

result = runQuality(map => { map.layouts[0].runtime_chrome.states[1].context_label = 'Styles'; });
assert.strictEqual(result.proc.status, 1);
assert(result.report.errors.some(error => error.includes('generic feature label')));

result = runQuality(map => {
    const overlay = map.layouts[0].runtime_chrome.regions.find(region => region.id === 'confirm');
    overlay.items = overlay.items.filter(item => !['templates-group', 'template-change'].includes(item.id));
});
assert.strictEqual(result.proc.status, 1);
assert(result.report.errors.some(error => error.includes('changed-entity group')));

result = runQuality(map => { map.route_index.editor.partials_expanded = []; });
assert.strictEqual(result.proc.status, 1);
assert(result.report.errors.some(error => error.includes('recursively expanded')));

// The reusable WordPress profile converts a shallow detector result into a
// source-backed schema-v5 recipe that passes both coverage and quality gates.
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rtfm-runtime-profile-'));
    const required = {
        'src/wp-admin/site-editor.php': "wp.editSite.initializeEditor('site-editor', {});",
        'src/wp-includes/default-constants.php': "define( 'WP_DEFAULT_THEME', 'twentytwentyfive' );",
        'src/wp-includes/block-template-utils.php': "'home' => array(\n 'title' => _x( 'Blog Home', 'Template name' ),\n 'description' => __( 'Displays the latest posts.' ),\n),",
        'src/wp-content/themes/twentytwentyfive/style.css': 'Theme Name: Twenty Twenty-Five\n',
        'src/wp-content/themes/twentytwentyfive/templates/home.html': '<main>home</main>',
        'src/wp-content/themes/twentytwentyfive/parts/header.html': '<header/>',
        'src/wp-content/themes/twentytwentyfive/parts/footer.html': '<footer/>',
        'src/wp-content/themes/twentytwentyfive/patterns/header.php': 'header',
        'src/wp-content/themes/twentytwentyfive/patterns/footer.php': 'Designed with WordPress',
        'src/wp-content/themes/twentytwentyfive/patterns/hidden-blog-heading.php': 'Blog',
        'src/wp-content/themes/twentytwentyfive/patterns/template-query-loop.php': 'query',
        'src/wp-content/themes/twentytwentyfive/theme.json': '{}',
        'src/wp-content/themes/twentytwentyfive/assets/images/botany-flowers.webp': 'image',
        'src/wp-content/themes/twentytwentyfive/assets/images/category-sunflowers.webp': 'image',
    };
    for (const [rel, value] of Object.entries(required)) write(path.join(root, rel), value);
    const mapPath = path.join(root, 'project_map.json');
    write(mapPath, {
        schema_version: 5, app_shell: { root_classes: { html: ['wp-toolbar'], body: ['wp-admin'] } },
        layouts: [{ name: 'site-editor', path: 'src/wp-admin/site-editor.php', chrome: [], runtime_chrome: {
            source_kind: 'knowledge', source_files: ['src/wp-admin/site-editor.php'], regions: [], states: [],
        }}],
        route_index: { 'site-editor': { path: '/wp-admin/site-editor.php', primary_view: 'src/wp-admin/site-editor.php', layout: 'site-editor' } },
        default_user_assumptions: [], runtime_surface_coverage: { ignored: [] },
    });
    let proc = spawnSync(process.execPath, [profiles, mapPath, root], { encoding: 'utf8' });
    assert.strictEqual(proc.status, 0, proc.stderr);
    const enriched = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
    const site = enriched.layouts.find(layout => layout.name === 'site-editor');
    assert.strictEqual(site.runtime_chrome.states[1].context_label, 'Blog Home');
    assert.strictEqual(site.runtime_chrome.regions.find(region => region.id === 'navigation').appearance.includes('dark #1e1e1e'), true);
    assert.strictEqual(site.runtime_chrome.regions.find(region => region.id === 'confirm').items.filter(item => item.kind === 'selection-row').length, 2);
    proc = spawnSync(process.execPath, [coverage, mapPath, root], { encoding: 'utf8' });
    assert.strictEqual(proc.status, 0, proc.stderr);
    proc = spawnSync(process.execPath, [checker, mapPath, root], { encoding: 'utf8' });
    assert.strictEqual(proc.status, 0, proc.stderr);
    fs.rmSync(root, { recursive: true, force: true });
}

console.log('runtime recipe quality tests passed');
