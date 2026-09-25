#!/usr/bin/env node
'use strict';

// Tests for the Node helpers that replaced the Python scripts and jq filters.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { sanitize } = require('./sanitize_css.js');
const { overrideCss } = require('./theme_overrides.js');
const { merge } = require('./merge_json.js');
const { check } = require('./check_project_map.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'detect-helpers-'));
const run = (script, args) => spawnSync(process.execPath, [path.join(__dirname, script), ...args], { encoding: 'utf8' });
const write = (name, value) => {
    const file = path.join(tmp, name);
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
    return file;
};

// sanitize_css: directives and their blocks go, everything else stays.
{
    const { cleaned, removed } = sanitize('@import "tailwindcss";\n@theme {\n  --x: 1;\n  inner { }\n}\n.keep { a: b; }\n  @apply foo;\n@plugin "x";\n');
    assert.strictEqual(cleaned, '.keep { a: b; }\n');
    assert.strictEqual(removed, 7);
}

// theme_overrides: expected output captured from the Python implementation.
{
    const detect = {
        theme_overrides: {
            colors: { primary: '#3366ff', secondary: '#ff6600', dark: 'null', x: '' },
            custom_colors: { brand_blue: '#123456', empty: '' },
            fonts: { body: 'Inter, sans-serif', heading: 'Poppins' },
            border_radius: '6px',
            extra_css: '@tailwind base;\n.foo { color: red; }\n  @apply p-4;\n@layer x {\n.bar{}\n',
        },
    };
    assert.strictEqual(overrideCss(detect, 'bootstrap'), '\n/* Theme overrides from project variables */\n:root {\n  --bs-primary: #3366ff;\n  --bs-primary-rgb: 51, 102, 255;\n  --bs-secondary: #ff6600;\n  --bs-secondary-rgb: 255, 102, 0;\n  --bs-body-font-family: Inter, sans-serif;\n  --bs-heading-font-family: Poppins;\n  --bs-border-radius: 6px;\n}\n.text-brand-blue { color: #123456 !important; }\n.bg-brand-blue { background-color: #123456 !important; }\n.btn-primary { background-color: #3366ff; border-color: #3366ff; }\n.btn-primary:hover { background-color: #3366ff; border-color: #3366ff; opacity: 0.9; }\n.btn-outline-primary { color: #3366ff; border-color: #3366ff; }\n.btn-outline-primary:hover { background-color: #3366ff; border-color: #3366ff; color: #fff; }\na { color: #3366ff; }\n.text-primary { color: #3366ff !important; }\n.bg-primary { background-color: #3366ff !important; }\n.btn-secondary { background-color: #ff6600; border-color: #ff6600; }\n\n/* Extra project overrides */\n.foo { color: red; }\n.bar{}\n');
    assert.strictEqual(overrideCss(detect, 'tailwind'), '\n/* Theme overrides from project variables */\n:root {\n  --color-primary: #3366ff;\n  --color-secondary: #ff6600;\n  font-family: Inter, sans-serif;\n  --font-heading: Poppins;\n  --radius: 6px;\n}\nh1, h2, h3, h4, h5, h6 { font-family: Poppins; }\n.text-primary { color: #3366ff; }\n.bg-primary { background-color: #3366ff; }\n.text-secondary { color: #ff6600; }\n.bg-secondary { background-color: #ff6600; }\n.text-brand-blue { color: #123456; }\n.bg-brand-blue { background-color: #123456; }\n\n/* Extra project overrides */\n.foo { color: red; }\n.bar{}\n');
    // Skill-style detection maps default_colors/scss_vars when no theme colours exist.
    const skillStyle = overrideCss({ default_colors: { primary: '#0ea5e9', accent: '#f43f5e' }, scss_vars: { 'body-color': '#111' } }, 'custom');
    assert(skillStyle.includes('  --color-secondary: #f43f5e;'));
    assert(skillStyle.includes('  --color-body_color: #111;'));
    // An invalid hex colour fails the run, as the caller treats that as "no overrides".
    assert.throws(() => overrideCss({ theme_overrides: { colors: { primary: '#zz0000' } } }, 'bootstrap'));
}

// json_get: jq-compatible reads used by the SKILL.md summaries.
{
    const file = write('map.json', {
        framework: 'bootstrap', has_tui: false, css_files: ['a.css', null, 'b.css'],
        route_index: { a: { method: 'CANVAS' }, b: { method: 'GET' }, c: { method: 'CANVAS' } },
        mockup_model_recommendation: { tier: 'medium', reasons: [{ code: 'r1' }, { code: 'r2' }] },
    });
    const out = args => run('json_get.js', args).stdout.trim();
    assert.strictEqual(out([file, 'framework', 'none']), 'bootstrap');
    assert.strictEqual(out([file, 'missing', 'none']), 'none');
    assert.strictEqual(out([file, 'missing']), 'null');
    assert.strictEqual(out([file, 'has_tui', 'false']), 'false');
    assert.strictEqual(out([file, 'css_files[]', '']), 'a.css\nb.css');
    assert.strictEqual(out(['--length', file, 'route_index']), '3');
    assert.strictEqual(out(['--length', file, 'missing']), '0');
    assert.strictEqual(out(['--join', ', ', file, 'mockup_model_recommendation.reasons[].code']), 'r1, r2');
    assert.strictEqual(out(['--count', file, 'route_index[]', 'method=CANVAS']), '2');
    assert.strictEqual(run('json_get.js', ['--exists', file, 'route_index.a']).status, 0);
    assert.strictEqual(run('json_get.js', ['--exists', file, 'route_index.z']).status, 1);
    assert.strictEqual(run('json_get.js', ['--valid', file]).status, 0);
    assert.strictEqual(run('json_get.js', ['--valid', write('bad.json', '{bad')]).status, 1);
}

// write_branding: web merges the detect output; patch modes keep existing fields.
{
    const brandDir = fs.mkdtempSync(path.join(tmp, 'brand-'));
    fs.writeFileSync(path.join(brandDir, 'branding-detect.json'), JSON.stringify({ framework: 'tailwind', google_fonts: ['x'] }));
    assert.strictEqual(run('write_branding.js', ['web', brandDir, 'tailwind_v4', ' 1234']).status, 0);
    const web = JSON.parse(fs.readFileSync(path.join(brandDir, 'branding.json'), 'utf8'));
    assert.deepStrictEqual({ ...web, generated_at: undefined }, {
        framework: 'tailwind', google_fonts: ['x'], compiled_css_path: 'branding.css',
        compilation_method: 'tailwind_v4', compiled_css_bytes: 1234, generated_at: undefined,
    });
    assert.match(web.generated_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);

    const branding = path.join(brandDir, 'branding.json');
    assert.strictEqual(run('write_branding.js', ['game', branding, 'phaser', '320', '180', '1280', '720', '55']).status, 0);
    const game = JSON.parse(fs.readFileSync(branding, 'utf8'));
    assert.strictEqual(game.framework, 'tailwind');
    assert.deepStrictEqual(game.canvas_size, { width: 320, height: 180 });
    assert.strictEqual(game.compiled_css_bytes, 55);
    assert.strictEqual(run('write_branding.js', ['game', branding, 'phaser', '320', 'abc', '1', '1', '1']).status, 1);
    assert.strictEqual(run('write_branding.js', ['win32', branding]).status, 2);
}

// merge_json: objects merge, arrays replace, omitted keys survive.
assert.deepStrictEqual(
    merge({ app_type: 'web', route_index: { a: { x: 1 } }, layouts: [1] }, { route_index: { b: { y: 2 } }, layouts: [2, 3] }),
    { app_type: 'web', route_index: { a: { x: 1 }, b: { y: 2 } }, layouts: [2, 3] },
);

// check_project_map: the gates that replaced the jq validation.
{
    const state = id => ({
        id, kind: 'overview', topic_tags: ['t'], instructional_priority: 'orientation', canvas_presentation: 'full',
        screenshot_required: true, visible_regions: ['top'], required_regions: [], required_strings: [], source_files: [],
    });
    const web = {
        app_type: 'web', app_type_source: 'hint', schema_version: 5, dir_map: {},
        layouts: [{
            name: 'app',
            runtime_chrome: {
                source_kind: 'repo', source_files: [],
                regions: [{ id: 'top', placement: 'top', required: true, appearance: 'bar', required_strings: [], source_files: [], items: [{ id: 'i', kind: 'k', description: 'd', required_strings: [] }] }],
                states: [state('a'), state('b'), state('c')],
            },
        }],
    };
    assert.deepStrictEqual(check('web', web), []);
    const tooMany = structuredClone(web);
    tooMany.layouts[0].runtime_chrome.states.push(state('d'));
    assert.match(check('web', tooMany).join('\n'), /at most 3 states/);
    const badPlacement = structuredClone(web);
    badPlacement.layouts[0].runtime_chrome.regions[0].placement = 'middle';
    assert.match(check('web', badPlacement).join('\n'), /placement/);

    const codebase = fs.mkdtempSync(path.join(tmp, 'rails-'));
    fs.mkdirSync(path.join(codebase, 'config'));
    fs.writeFileSync(path.join(codebase, 'config', 'routes.rb'), '');
    assert.match(check('web', web, codebase).join('\n'), /route_index/);

    const game = { app_type: 'game', app_type_source: 'hint', game_metadata: {}, app_shell: null, route_index: { play: { method: 'CANVAS', scene_anatomy: { layers: ['bg'] } } } };
    assert.deepStrictEqual(check('game', game), []);
    assert.match(check('game', { ...game, route_index: { play: { method: 'CANVAS', scene_anatomy: { layers: [] } } } }).join('\n'), /layers/);
    assert.match(check('mobile', { app_type: 'web', app_type_source: 'x' }).join('\n'), /app_type must be "mobile"/);
    assert.strictEqual(run('check_project_map.js', ['game', write('game.json', game)]).status, 0);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('node helper tests passed');
