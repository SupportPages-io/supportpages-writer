#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const checker = path.join(__dirname, 'check_runtime_coverage.js');

function write(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

function run(mutator = () => {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rtfm-runtime-coverage-'));
    write(path.join(root, 'views/editor.php'), 'enqueue(); app.initializeEditor("editor", {}); <div id="editor"></div>');
    write(path.join(root, 'views/other.php'), 'plain server rendered page');
    write(path.join(root, 'views/preview.webp'), 'representative-image');
    const map = {
        layouts: [{ name: 'editor', path: 'views/editor.php', chrome: [], runtime_chrome: {
            source_kind: 'repo', source_files: ['views/editor.php'], regions: [], states: [],
        }}],
        route_index: { editor: { controller: 'views/editor.php', layout: 'editor' },
            other: { controller: 'views/other.php', layout: 'plain' } },
    };
    mutator(map, root);
    write(path.join(root, 'project_map.json'), map);
    const reportPath = path.join(root, 'coverage.json');
    const proc = spawnSync(process.execPath, [checker, path.join(root, 'project_map.json'), root, '--json', reportPath], { encoding: 'utf8' });
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    fs.rmSync(root, { recursive: true, force: true });
    return { proc, report };
}

function strongSiteEditorRecipe() {
    const src = ['views/editor.php'];
    return {
        app: 'Site editor',
        mode_note: 'The editor opens with persistent navigation, toolbar, and canvas.',
        source_kind: 'repo',
        source_files: src,
        regions: [
            { id: 'toolbar', region: 'editor toolbar', placement: 'top', required: true,
                appearance: 'A full-width dark toolbar above the workspace.',
                items: ['site icon', 'view toggle', 'save control'], ui_strings: ['View', 'Save'],
                required_strings: ['Save'], source_files: src },
            { id: 'site-navigation', region: 'site navigation', placement: 'left', required: true,
                appearance: 'A wide left rail of editor destinations.',
                items: ['Navigation row', 'Styles row', 'Templates row'],
                ui_strings: ['Navigation', 'Styles', 'Templates'], required_strings: ['Styles'], source_files: src },
            { id: 'canvas', region: 'editing canvas', placement: 'canvas', required: true,
                appearance: 'A dominant central preview of the site.',
                items: ['site preview', 'selected content outline'], ui_strings: ['Design'],
                required_strings: ['Design'], source_files: src },
            { id: 'settings', region: 'editing settings', placement: 'right', required: false,
                appearance: 'A settings sidebar aligned to the right edge.',
                items: ['settings tabs', 'property controls'], ui_strings: ['Settings'],
                required_strings: ['Settings'], source_files: src },
            { id: 'save-confirmation', region: 'save confirmation', placement: 'overlay-right', required: false,
                appearance: 'A raised confirmation panel over the right side of the canvas.',
                items: ['changed items summary', 'cancel button', 'confirm save button'],
                ui_strings: ['Review changes', 'Cancel', 'Save'],
                required_strings: ['Review changes', 'Save'], source_files: src },
        ],
        states: [
            { id: 'overview', name: 'overview', kind: 'overview', screenshot_required: false,
                entered_by: 'open the editor', shows: 'the editor overview',
                visible_regions: ['toolbar', 'site-navigation', 'canvas'], required_regions: [],
                required_strings: [], source_files: src },
            { id: 'edit-styles', name: 'edit styles', kind: 'action', screenshot_required: true,
                entered_by: 'open Styles', shows: 'style controls beside the preview',
                visible_regions: ['toolbar', 'site-navigation', 'canvas', 'settings'], required_regions: ['settings'],
                required_strings: ['Styles'], source_files: src },
            { id: 'edit-templates', name: 'edit templates', kind: 'action', screenshot_required: true,
                entered_by: 'open Templates', shows: 'template controls beside the preview',
                visible_regions: ['toolbar', 'site-navigation', 'canvas', 'settings'], required_regions: ['settings'],
                required_strings: ['Templates'], source_files: src },
            { id: 'confirm-save', name: 'confirm save', kind: 'confirm', screenshot_required: true,
                entered_by: 'press Save', shows: 'the save review over the edited canvas',
                visible_regions: ['toolbar', 'site-navigation', 'canvas', 'settings', 'save-confirmation'],
                required_regions: ['save-confirmation'], required_strings: ['Save'], source_files: src },
        ],
    };
}

function runV3(recipeMutator = () => {}) {
    return run(map => {
        map.schema_version = 3;
        map.layouts[0].runtime_chrome = strongSiteEditorRecipe();
        recipeMutator(map.layouts[0].runtime_chrome, map);
    });
}

function runV4(recipeMutator = () => {}) {
    return run(map => {
        map.schema_version = 4;
        const recipe = strongSiteEditorRecipe();
        for (const region of recipe.regions) {
            region.items = region.items.map((description, index) => ({ id: `item-${index + 1}`, description }));
            if (region.placement === 'canvas') Object.assign(region, {
                content_mode: 'populated', media_expectation: 'required',
                representative_assets: ['views/preview.webp'], max_selected_outlines: 1,
            });
        }
        const priorities = ['orientation', 'primary-action', 'secondary-action', 'terminal-action'];
        recipe.states.forEach((state, index) => {
            state.topic_tags = [state.name];
            state.instructional_priority = priorities[index];
            if (state.kind === 'action') state.screenshot_required = false;
        });
        map.layouts[0].runtime_chrome = recipe;
        recipeMutator(recipe, map);
    });
}

let result = run();
assert.strictEqual(result.proc.status, 0, result.proc.stderr);
assert.strictEqual(result.report.candidates.length, 1);

result = run((map, root) => {
    write(path.join(root, 'views/site.php'), 'scripts(); product.initializeApplication("site", {});');
    map.route_index.site = { controller: 'views/site.php', layout: 'editor' };
});
assert.strictEqual(result.proc.status, 1);
assert(result.report.errors.some(error => error.includes('views/site.php')));

result = run((map, root) => {
    write(path.join(root, 'views/site.php'), 'scripts(); product.initializeApplication("site", {});');
    map.route_index.site = { controller: 'views/site.php', layout: 'editor' };
    map.layouts[0].runtime_chrome.source_files.push('views/site.php');
});
assert.strictEqual(result.proc.status, 1);
assert(result.report.errors.some(error => error.includes('combines distinct mount files')));

result = run((map, root) => {
    write(path.join(root, 'views/site.php'), 'scripts(); product.initializeApplication("site", {});');
    map.route_index.site = { controller: 'views/site.php', layout: 'editor' };
    map.runtime_surface_coverage = { ignored: [{ source_file: 'views/site.php', reason: 'progressive enhancement only' }] };
});
assert.strictEqual(result.proc.status, 0, result.proc.stderr);

// A complete schema-v3 Site Editor-shaped recipe is accepted.
result = runV3();
assert.strictEqual(result.proc.status, 0, result.proc.stderr);

// The old descriptive recipe shape cannot pass as an enforceable v3 recipe.
result = run((map) => {
    map.schema_version = 3;
    map.layouts[0].runtime_chrome = {
        app: 'Site editor', mode_note: 'Fullscreen editor', source_kind: 'repo',
        source_files: ['views/editor.php'],
        regions: [
            { id: 'navigation', region: 'navigation', placement: 'left', required: true,
                items: ['Navigation', 'Styles', 'Templates'], ui_strings: ['Navigation', 'Styles', 'Templates'],
                required_strings: ['Styles'], source_files: ['views/editor.php'] },
            { id: 'canvas', region: 'canvas', placement: 'canvas', required: true,
                items: ['preview'], ui_strings: ['Design'], required_strings: ['Design'], source_files: ['views/editor.php'] },
            { id: 'confirm', region: 'confirmation', placement: 'overlay-right', required: false,
                items: ['Save'], ui_strings: ['Save'], required_strings: ['Save'], source_files: ['views/editor.php'] },
        ],
        states: [
            { id: 'editing', kind: 'action', screenshot_required: true, required_strings: ['Styles'] },
            { id: 'confirm-save', kind: 'confirm', screenshot_required: true, required_strings: ['Save'] },
        ],
    };
});
assert.strictEqual(result.proc.status, 1);
assert(result.report.errors.some(error => error.includes('appearance')));
assert(result.report.errors.some(error => error.includes('visible_regions')));
assert(result.report.errors.some(error => error.includes('overlay runtime region')));

// The schema-v3 contract rejects weak IDs and inconsistent region visibility.
result = runV3(recipe => { recipe.regions[0].id = 'Bad ID'; });
assert.strictEqual(result.proc.status, 1);
assert(result.report.errors.some(error => error.includes('unique kebab-case region ids')));

result = runV3(recipe => { recipe.states[2].id = recipe.states[1].id; });
assert.strictEqual(result.proc.status, 1);
assert(result.report.errors.some(error => error.includes('unique kebab-case state ids')));

result = runV3(recipe => {
    recipe.app = '';
    recipe.mode_note = ' ';
    recipe.regions[0].region = '';
    recipe.regions[0].items = [];
    recipe.regions[0].appearance = '';
});
assert.strictEqual(result.proc.status, 1);
for (const field of ['app', 'mode_note', 'region label', 'items', 'appearance']) {
    assert(result.report.errors.some(error => error.includes(field)), `missing ${field} validation`);
}

result = runV3(recipe => { recipe.regions[3].required = true; });
assert.strictEqual(result.proc.status, 1);
assert(result.report.errors.some(error => error.includes("runtime region 'settings' required")));

result = runV3(recipe => { recipe.states[1].visible_regions = ['canvas', 'toolbar']; });
assert.strictEqual(result.proc.status, 1);
assert(result.report.errors.some(error => error.includes('recipe order')));

result = runV3(recipe => { recipe.states[0].screenshot_required = true; });
assert.strictEqual(result.proc.status, 1);
assert(result.report.errors.some(error => error.includes('overview state')));

result = runV3(recipe => {
    recipe.states[0].kind = 'action';
    recipe.states[0].screenshot_required = true;
    recipe.states[0].required_strings = ['Design'];
});
assert.strictEqual(result.proc.status, 1);
assert(result.report.errors.some(error => error.includes('more than three screenshot-required states')));

result = runV3(recipe => {
    recipe.states[1].visible_regions = [];
    recipe.states[1].required_strings = [];
});
assert.strictEqual(result.proc.status, 1);
assert(result.report.errors.some(error => error.includes('must have visible_regions')));
assert(result.report.errors.some(error => error.includes('visible required string assertion')));

result = runV3(recipe => { recipe.regions[4].required_strings = ['Save']; });
assert.strictEqual(result.proc.status, 1);
assert(result.report.errors.some(error => error.includes('at least two required_strings')));

result = runV3(recipe => { recipe.regions[4].items = ['summary', 'save']; });
assert.strictEqual(result.proc.status, 1);
assert(result.report.errors.some(error => error.includes('at least three items')));

result = runV3(recipe => {
    recipe.states = recipe.states.filter(state => state.id !== 'edit-templates');
});
assert.strictEqual(result.proc.status, 1);
assert(result.report.errors.some(error => error.includes('at least two action states')));
assert(result.report.errors.some(error => error.includes('at least two screenshot-required action states')));

result = runV3(recipe => {
    recipe.source_files = ['views/other.php'];
});
assert.strictEqual(result.proc.status, 1);
assert(result.report.errors.some(error => error.includes('must include its layout mount')));

// Schema v4 adds executable item inventories, topic-aware state selection,
// and source-backed populated-canvas evidence without requiring every action
// branch to consume a screenshot slot.
result = runV4();
assert.strictEqual(result.proc.status, 0, result.proc.stderr);

result = runV4(recipe => { recipe.regions[0].items[0] = { id: 'Bad ID', description: '' }; });
assert.strictEqual(result.proc.status, 1);
assert(result.report.errors.some(error => error.includes('ordered items')));

result = runV4(recipe => { delete recipe.states[1].topic_tags; });
assert.strictEqual(result.proc.status, 1);
assert(result.report.errors.some(error => error.includes('topic_tags')));

result = runV4(recipe => { recipe.regions[2].representative_assets = []; });
assert.strictEqual(result.proc.status, 1);
assert(result.report.errors.some(error => error.includes('requires representative_assets')));

function v5Mutator(extra = () => {}) {
    return (recipe, map) => {
        map.schema_version = 5;
        for (const region of recipe.regions) {
            for (const item of region.items) Object.assign(item, { kind: 'control-group', required_strings: [] });
        }
        const overlay = recipe.regions.find(region => region.placement.startsWith('overlay-'));
        overlay.items[0].kind = 'group-heading';
        overlay.items[1].kind = 'selection-row';
        overlay.items[2].kind = 'actions';
        for (const state of recipe.states) {
            state.canvas_presentation = 'The populated canvas fills the workspace.';
            if (['action', 'confirm'].includes(state.kind)) {
                state.context_label = 'Editor document';
                state.required_strings.push(state.context_label);
            }
        }
        extra(recipe, map);
    };
}

result = runV4(v5Mutator());
assert.strictEqual(result.proc.status, 0, result.proc.stderr);

result = runV4(v5Mutator(recipe => { delete recipe.regions[0].items[0].kind; }));
assert.strictEqual(result.proc.status, 1);
assert(result.report.errors.some(error => error.includes('items require kebab-case kind')));

result = runV4(v5Mutator(recipe => { recipe.states[1].context_label = 'Missing from assertions'; }));
assert.strictEqual(result.proc.status, 1);
assert(result.report.errors.some(error => error.includes('concrete context_label')));

result = runV4(v5Mutator(recipe => { recipe.regions[4].items[1].description = 'No changes'; }));
assert.strictEqual(result.proc.status, 1);
assert(result.report.errors.some(error => error.includes('concrete changed entities')));

// Ignore entries are typed, unique, and mutually exclusive with ownership.
result = run((map) => {
    map.runtime_surface_coverage = { ignored: 'views/editor.php' };
});
assert.strictEqual(result.proc.status, 1);
assert(result.report.errors.some(error => error.includes('ignored must be an array')));

result = run((map) => {
    map.layouts = [];
    map.runtime_surface_coverage = { ignored: [{ source_file: 'views/editor.php', reason: 'x' }] };
});
assert.strictEqual(result.proc.status, 1);
assert(result.report.errors.some(error => error.includes('specific reason')));

result = run((map) => {
    map.runtime_surface_coverage = { ignored: [
        { source_file: 'views/editor.php', reason: 'progressive enhancement only' },
        { source_file: 'views/editor.php', reason: 'duplicate progressive enhancement' },
    ] };
});
assert.strictEqual(result.proc.status, 1);
assert(result.report.errors.some(error => error.includes('duplicate source_file')));
assert(result.report.errors.some(error => error.includes('both owned and ignored')));

console.log('runtime surface coverage tests passed');
