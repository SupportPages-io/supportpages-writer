#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { classify, POLICY_VERSION } = require('./recommend_model_tier.js');

const classifier = path.join(__dirname, 'recommend_model_tier.js');
const webBranding = { framework: 'rails', compilation_method: 'source_compile' };

function shell(regionCount = 0, navItems = 0) {
    const out = { nav_items: Array.from({ length: navItems }, (_, index) => ({ label: `Item ${index}` })) };
    const keys = ['top_bar', 'titlebar', 'menu_bar', 'global_sidebar', 'primary_sidebar', 'secondary_sidebar'];
    keys.slice(0, regionCount).forEach(key => { out[key] = `${key} definition`; });
    return out;
}

function routes(count, fanout = 0) {
    return Object.fromEntries(Array.from({ length: count }, (_, index) => [
        `route-${index}`,
        { path: `/route-${index}`, partials_expanded: Array.from({ length: fanout }, (__, part) => `part-${part}`) },
    ]));
}

function expectTier(name, map, branding, tier) {
    const recommendation = classify(map, branding);
    assert.strictEqual(recommendation.tier, tier, `${name}: ${JSON.stringify(recommendation)}`);
    assert.strictEqual(recommendation.policy_version, POLICY_VERSION);
    assert(!JSON.stringify(recommendation).match(/claude|gpt|codex|cursor|opus|sonnet/i),
        `${name}: recommendation leaked a concrete model or harness`);
    return recommendation;
}

// Representative project shapes.
expectTier('server-rendered web app', {
    app_type: 'web', framework: 'rails', layouts: Array.from({ length: 7 }, () => ({})),
    route_index: routes(6), app_shell: null,
}, webBranding, 'low');

expectTier('WordPress Site Editor runtime', {
    app_type: 'web', framework: 'custom', route_index: routes(29), app_shell: shell(2, 11),
    layouts: [{ runtime_chrome: {
        regions: Array.from({ length: 11 }, (_, index) => ({ placement: index === 2 ? 'canvas' : 'left' })),
        states: Array.from({ length: 8 }, () => ({})),
    }}],
}, { framework: 'custom', compilation_method: 'source_compile' }, 'high');

expectTier('desktop database workspace', {
    app_type: 'desktop', framework: 'vue', layouts: [], route_index: routes(14), app_shell: shell(6, 3),
}, { framework: 'vue', compilation_method: 'source_compile' }, 'high');

for (const [name, map] of [
    ['Immich-style mobile app', { app_type: 'mobile', framework: 'mobile', screen_index: routes(20), app_shell: shell(1, 4) }],
    ['Notepad++-style Win32 app', { app_type: 'win32', framework: 'win32', dialog_index: routes(20), app_shell: shell(1, 13) }],
    ['TGT-style terminal app', { app_type: 'terminal', framework: 'terminal', command_index: routes(8), app_shell: null }],
    ['Transmission-style macOS app', { app_type: 'macos', framework: 'macos', view_index: routes(12), app_shell: shell(2, 0) }],
]) expectTier(name, map, { framework: map.framework }, 'medium');

expectTier('canvas game', {
    app_type: 'game', framework: 'custom', layouts: [], route_index: {
        play: { method: 'CANVAS', scene_anatomy: { layers: ['background', 'player'] } },
    },
}, { framework: 'custom' }, 'high');

expectTier('simple runtime mount', {
    app_type: 'web', framework: 'rails', layouts: [{ runtime_chrome: { regions: [{}], states: [{}] } }],
    route_index: routes(3),
}, webBranding, 'medium');

expectTier('fallback CSS floor', {
    app_type: 'web', framework: 'tailwind', layouts: [], route_index: routes(3),
}, { framework: 'tailwind', compilation_method: 'fallback_synthesis' }, 'medium');

expectTier('unknown metadata is conservative', { layouts: [], route_index: {} }, {}, 'medium');

const boundaryMedium = expectTier('medium score boundary', {
    app_type: 'web', framework: 'rails', layouts: Array.from({ length: 5 }, () => ({})),
    route_index: routes(25), app_shell: shell(0, 8),
}, webBranding, 'medium');
assert.strictEqual(boundaryMedium.score, 3);

expectTier('high score boundary', {
    app_type: 'web', framework: 'custom', layouts: Array.from({ length: 5 }, () => ({})),
    route_index: routes(25, 8), app_shell: shell(0, 8),
}, { framework: 'custom' }, 'high');

assert.throws(() => classify([], {}), /project map must be a JSON object/);
assert.throws(() => classify({}, []), /branding cache must be a JSON object/);

// Exercise the actual CLI, atomic write, replacement, and byte-stable rerun.
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rtfm-model-tier-'));
    const mapPath = path.join(root, 'project_map.json');
    const brandingPath = path.join(root, 'branding.json');
    fs.writeFileSync(mapPath, JSON.stringify({
        app_type: 'web', framework: 'rails', layouts: [], route_index: routes(2),
        mockup_model_recommendation: { tier: 'stale', reasons: ['stale'] },
    }, null, 2));
    fs.writeFileSync(brandingPath, JSON.stringify(webBranding));
    let proc = spawnSync(process.execPath, [classifier, mapPath, brandingPath], { encoding: 'utf8' });
    assert.strictEqual(proc.status, 0, proc.stderr);
    const first = fs.readFileSync(mapPath, 'utf8');
    const parsed = JSON.parse(first);
    assert.strictEqual(parsed.mockup_model_recommendation.tier, 'low');
    assert(!JSON.stringify(parsed.mockup_model_recommendation).includes('stale'));
    proc = spawnSync(process.execPath, [classifier, mapPath, brandingPath], { encoding: 'utf8' });
    assert.strictEqual(proc.status, 0, proc.stderr);
    assert.strictEqual(fs.readFileSync(mapPath, 'utf8'), first);
    fs.writeFileSync(mapPath, '{ malformed json');
    proc = spawnSync(process.execPath, [classifier, mapPath, brandingPath], { encoding: 'utf8' });
    assert.notStrictEqual(proc.status, 0);
    assert.match(proc.stderr, /cannot read project map/);
    fs.rmSync(root, { recursive: true, force: true });
}

console.log('model tier recommendation tests passed');
