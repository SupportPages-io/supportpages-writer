#!/usr/bin/env node
'use strict';

// Detect high-confidence client-rendered application mounts in files referenced
// by project_map routes/layouts. Every distinct mount must own a runtime_chrome
// recipe or carry an explicit reasoned ignore entry.

const fs = require('fs');
const path = require('path');

function die(message) {
    console.error(`ERROR: ${message}`);
    process.exit(2);
}

const mapPath = process.argv[2];
const projectDir = process.argv[3];
const jsonIndex = process.argv.indexOf('--json');
const reportPath = jsonIndex >= 0 ? process.argv[jsonIndex + 1] : null;
if (!mapPath || !projectDir) die('usage: check_runtime_coverage.js <project_map.json> <project_dir> [--json report.json]');

let projectMap;
try {
    projectMap = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
} catch (err) {
    die(`cannot read project map: ${err.message}`);
}

const mountSignals = [
    ['initialize-app', /(?:\.|\b)initialize(?:Editor|App|Application)\s*\(/],
    ['react-root', /\b(?:createRoot|hydrateRoot)\s*\(|ReactDOM\s*\.\s*(?:render|hydrate)\s*\(/],
    ['vue-app', /\bcreateApp\s*\([^)]*\)\s*\.\s*mount\s*\(|\bnew\s+Vue\s*\(/],
    ['angular-bootstrap', /\bangular\s*\.\s*bootstrap\s*\(/],
    ['explicit-dom-mount', /\b(?:mount|hydrate)\s*\(\s*(?:document\.(?:getElementById|querySelector)|['"`]#[^'"`]+['"`])/],
];

function norm(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    const clean = value.split(/[?#]/, 1)[0].replace(/^\.\//, '');
    const abs = path.resolve(projectDir, clean);
    const root = path.resolve(projectDir) + path.sep;
    if (!abs.startsWith(root) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
    return path.relative(projectDir, abs).split(path.sep).join('/');
}

const sources = new Map();
function addSource(value, consumer) {
    const rel = norm(value);
    if (!rel) return;
    if (!sources.has(rel)) sources.set(rel, new Set());
    sources.get(rel).add(consumer);
}

for (const layout of Array.isArray(projectMap.layouts) ? projectMap.layouts : []) {
    addSource(layout && layout.path, `layout:${layout && (layout.name || layout.path)}`);
}
for (const [key, route] of Object.entries(projectMap.route_index || {})) {
    if (!route || typeof route !== 'object') continue;
    for (const field of ['controller', 'primary_view', 'view', 'source_file']) addSource(route[field], `route:${key}`);
    for (const rel of route.partials_expanded || []) addSource(rel, `route:${key}`);
}

const candidates = [];
for (const [rel, consumers] of sources) {
    let source;
    try {
        const stat = fs.statSync(path.join(projectDir, rel));
        if (stat.size > 2 * 1024 * 1024) continue;
        source = fs.readFileSync(path.join(projectDir, rel), 'utf8');
    } catch (_) {
        continue;
    }
    const signals = mountSignals.filter(([, re]) => re.test(source)).map(([name]) => name);
    if (signals.length) candidates.push({ source_file: rel, signals, consumers: [...consumers].sort() });
}

const layouts = Array.isArray(projectMap.layouts) ? projectMap.layouts : [];
const errors = [];
const schemaV3 = Number(projectMap.schema_version) >= 3;
const schemaV4 = Number(projectMap.schema_version) >= 4;
const schemaV5 = Number(projectMap.schema_version) >= 5;
const ignoredValue = (projectMap.runtime_surface_coverage || {}).ignored;
const ignored = ignoredValue === undefined ? [] : ignoredValue;
if (!Array.isArray(ignored)) errors.push('runtime_surface_coverage.ignored must be an array');
const validIgnored = Array.isArray(ignored) ? ignored : [];

function nonempty(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

function stringArray(value, { nonemptyArray = false } = {}) {
    return Array.isArray(value)
        && (!nonemptyArray || value.length > 0)
        && value.every(nonempty);
}

function label(layout) {
    return layout && (layout.name || layout.path) || '?';
}

// Schema v3 turns runtime_chrome from a descriptive hint into an enforceable
// rendering contract. Keep older cached maps working, but reject v3 recipes
// that can be satisfied by empty tags or that omit a load-bearing app state.
if (schemaV3) {
    const kebab = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
    for (const layout of layouts.filter(item => item && item.runtime_chrome)) {
        const owner = label(layout);
        const recipe = layout.runtime_chrome;
        const regions = Array.isArray(recipe.regions) ? recipe.regions : [];
        const states = Array.isArray(recipe.states) ? recipe.states : [];
        const regionIds = regions.map(region => region && region.id);
        const stateIds = states.map(state => state && state.id);

        if (!nonempty(recipe.app)) errors.push(`runtime_chrome layout '${owner}' requires a non-empty app`);
        if (!nonempty(recipe.mode_note)) errors.push(`runtime_chrome layout '${owner}' requires a non-empty mode_note`);
        if (!stringArray(recipe.source_files, { nonemptyArray: true })) errors.push(
            `runtime_chrome layout '${owner}' requires non-empty source_files`);
        const mount = norm(layout.path);
        const topSources = new Set((Array.isArray(recipe.source_files) ? recipe.source_files : [])
            .map(norm).filter(Boolean));
        if (!mount || !topSources.has(mount)) errors.push(
            `runtime_chrome layout '${owner}' source_files must include its layout mount '${layout.path || '?'}'`);
        if (!regions.length) errors.push(`runtime_chrome layout '${owner}' requires at least one region`);
        if (!states.length) errors.push(`runtime_chrome layout '${owner}' requires at least one state`);

        if (regionIds.some(id => !nonempty(id) || !kebab.test(id))
            || new Set(regionIds).size !== regionIds.length) errors.push(
            `runtime_chrome layout '${owner}' requires unique kebab-case region ids`);
        if (stateIds.some(id => !nonempty(id) || !kebab.test(id))
            || new Set(stateIds).size !== stateIds.length) errors.push(
            `runtime_chrome layout '${owner}' requires unique kebab-case state ids`);

        for (const region of regions) {
            const id = region && region.id || '?';
            if (!region || !nonempty(region.region)) errors.push(`runtime region '${id}' requires a non-empty region label`);
            if (schemaV4) {
                const items = region && region.items;
                const itemIds = Array.isArray(items) ? items.map(item => item && item.id) : [];
                if (!Array.isArray(items) || !items.length || items.some(item => !item
                    || !nonempty(item.id) || !kebab.test(item.id) || !nonempty(item.description))
                    || new Set(itemIds).size !== itemIds.length) errors.push(
                    `schema-v4 runtime region '${id}' requires ordered items with unique kebab-case id and non-empty description`);
                if (schemaV5 && (!Array.isArray(items) || items.some(item => !nonempty(item.kind) || !kebab.test(item.kind)
                    || !Array.isArray(item.required_strings) || !item.required_strings.every(nonempty)))) errors.push(
                    `schema-v5 runtime region '${id}' items require kebab-case kind and required_strings`);
                if (schemaV5 && Array.isArray(items) && region.placement === 'right' && region.ui_strings.length >= 4
                    && items.length < 4) errors.push(
                    `schema-v5 right-panel region '${id}' must inventory its navigable rows as atomic items`);
                if (schemaV5 && Array.isArray(items) && typeof region.placement === 'string' && region.placement.startsWith('overlay-')) {
                    const kinds = new Set(items.map(item => item.kind));
                    if (!kinds.has('group-heading') || !kinds.has('selection-row') || !kinds.has('actions')) errors.push(
                        `schema-v5 grouped overlay region '${id}' requires atomic group-heading, selection-row, and actions items`);
                    const itemText = items.flatMap(item => [item.description, ...(item.required_strings || [])]).join(' ');
                    if (/\b(?:no changes?|unchanged)\b/i.test(itemText)) errors.push(
                        `schema-v5 overlay region '${id}' must list concrete changed entities, not unchanged rows`);
                }
            } else if (!region || !stringArray(region.items, { nonemptyArray: true })) errors.push(
                `runtime region '${id}' requires non-empty items`);
            if (!region || !nonempty(region.appearance)) errors.push(`runtime region '${id}' requires a non-empty appearance`);
            if (!region || typeof region.required !== 'boolean') errors.push(`runtime region '${id}' requires a boolean required flag`);
            if (!region || !Array.isArray(region.ui_strings) || !region.ui_strings.every(nonempty)) errors.push(
                `runtime region '${id}' requires a ui_strings array of non-empty strings`);
            if (!region || !Array.isArray(region.required_strings) || !region.required_strings.every(nonempty)) errors.push(
                `runtime region '${id}' requires a required_strings array of non-empty strings`);
            if (region && typeof region.placement === 'string' && region.placement.startsWith('overlay-')) {
                if (!Array.isArray(region.required_strings) || region.required_strings.length < 2) errors.push(
                    `overlay runtime region '${id}' requires at least two required_strings`);
                if (!Array.isArray(region.items) || region.items.length < 3) errors.push(
                    `overlay runtime region '${id}' requires at least three items`);
            }
            if (schemaV4 && region && region.placement === 'canvas') {
                if (!['populated', 'empty', 'loading'].includes(region.content_mode)) errors.push(
                    `schema-v4 canvas region '${id}' requires content_mode populated, empty, or loading`);
                if (!['required', 'optional', 'none'].includes(region.media_expectation)) errors.push(
                    `schema-v4 canvas region '${id}' requires media_expectation required, optional, or none`);
                if (!Number.isInteger(region.max_selected_outlines) || region.max_selected_outlines < 0) errors.push(
                    `schema-v4 canvas region '${id}' requires a non-negative max_selected_outlines integer`);
                const assets = region.representative_assets;
                if (!Array.isArray(assets) || assets.some(asset => !norm(asset))
                    || new Set(assets || []).size !== (assets || []).length) errors.push(
                    `schema-v4 canvas region '${id}' representative_assets must be unique existing repo files`);
                if (region.media_expectation === 'required' && (!Array.isArray(assets) || !assets.length)) errors.push(
                    `schema-v4 canvas region '${id}' requires representative_assets when media_expectation is required`);
            }
        }

        const regionOrder = new Map(regionIds.map((id, index) => [id, index]));
        for (const state of states) {
            const id = state && state.id || '?';
            const visible = state && state.visible_regions;
            if (!Array.isArray(visible)
                || visible.some(regionId => !regionOrder.has(regionId))
                || new Set(visible || []).size !== (visible || []).length
                || (visible || []).some((regionId, index) => index > 0
                    && regionOrder.get(regionId) <= regionOrder.get(visible[index - 1]))) {
                errors.push(`runtime state '${id}' visible_regions must be unique valid region ids in recipe order`);
            }
            if (!state || typeof state.screenshot_required !== 'boolean') errors.push(
                `runtime state '${id}' requires a boolean screenshot_required flag`);
            if (schemaV4 && (!stringArray(state && state.topic_tags, { nonemptyArray: true })
                || !['orientation', 'primary-action', 'secondary-action', 'terminal-action']
                    .includes(state && state.instructional_priority))) errors.push(
                `schema-v4 runtime state '${id}' requires topic_tags and a valid instructional_priority`);
            if (schemaV5) {
                if (!nonempty(state.canvas_presentation)) errors.push(
                    `schema-v5 runtime state '${id}' requires canvas_presentation`);
                const hasToolbar = Array.isArray(visible) && regions.some(region =>
                    visible.includes(region.id) && region.placement === 'top');
                if (hasToolbar && ['action', 'confirm'].includes(state.kind)
                    && (!nonempty(state.context_label)
                        || !Array.isArray(state.required_strings)
                        || !state.required_strings.includes(state.context_label))) errors.push(
                    `schema-v5 runtime state '${id}' requires a concrete context_label in required_strings`);
            }
            if (!state || !Array.isArray(state.required_strings) || !state.required_strings.every(nonempty)) errors.push(
                `runtime state '${id}' requires a required_strings array of non-empty strings`);
            if (state && state.kind === 'overview' && state.screenshot_required) errors.push(
                `runtime overview state '${id}' cannot be screenshot_required`);
            if (state && state.screenshot_required) {
                if (!Array.isArray(visible) || !visible.length) errors.push(
                    `screenshot-required runtime state '${id}' must have visible_regions`);
                const regionAssertions = regions.filter(region => (visible || []).includes(region.id))
                    .flatMap(region => Array.isArray(region.required_strings) ? region.required_strings : []);
                const stateAssertions = Array.isArray(state.required_strings) ? state.required_strings : [];
                if (![...stateAssertions, ...regionAssertions].some(nonempty)) errors.push(
                    `screenshot-required runtime state '${id}' requires a visible required string assertion`);
            }
        }

        if (states.filter(state => state && state.screenshot_required).length > 3) errors.push(
            `runtime_chrome layout '${owner}' has more than three screenshot-required states`);
        for (const region of regions) {
            const visibleInEveryState = states.length > 0
                && states.every(state => Array.isArray(state.visible_regions) && state.visible_regions.includes(region.id));
            if (typeof region.required === 'boolean' && region.required !== visibleInEveryState) errors.push(
                `runtime region '${region.id || '?'}' required must be true iff it is visible in every state`);
        }

        const leftNav = regions.some(region => region && region.placement === 'left'
            && Array.isArray(region.ui_strings) && region.ui_strings.length >= 3);
        const canvas = regions.some(region => region && region.placement === 'canvas');
        const confirmationOverlay = regions.some(region => region
            && typeof region.placement === 'string' && region.placement.startsWith('overlay-')
            && states.some(state => state && state.kind === 'confirm'
                && Array.isArray(state.visible_regions) && state.visible_regions.includes(region.id)));
        if (leftNav && canvas && confirmationOverlay) {
            const actions = states.filter(state => state && state.kind === 'action');
            const requiredActions = actions.filter(state => state.screenshot_required);
            if (actions.length < 2) errors.push(
                `runtime_chrome layout '${owner}' has navigation, canvas, and confirmation surfaces and requires at least two action states`);
            if (!schemaV4 && requiredActions.length < 2) errors.push(
                `runtime_chrome layout '${owner}' has navigation, canvas, and confirmation surfaces and requires at least two screenshot-required action states`);
        }
    }
}

const ignoredBySource = new Map();
for (const item of validIgnored) {
    const rel = item && norm(item.source_file);
    if (!item || typeof item !== 'object' || !rel || !nonempty(item.reason) || item.reason.trim().length < 12) {
        errors.push(`runtime_surface_coverage.ignored entries require an existing detected source_file and a specific reason (12+ characters): ${(item && item.source_file) || '?'}`);
        continue;
    }
    if (ignoredBySource.has(rel)) errors.push(`runtime_surface_coverage.ignored contains duplicate source_file: ${rel}`);
    ignoredBySource.set(rel, item.reason.trim());
}
const ownership = new Map();
for (const candidate of candidates) {
    const owners = layouts.filter(layout => {
        if (!layout || !layout.runtime_chrome) return false;
        if (norm(layout.path) === candidate.source_file) return true;
        return (layout.runtime_chrome.source_files || []).some(rel => norm(rel) === candidate.source_file);
    });
    const ignoreReason = ignoredBySource.get(candidate.source_file) || null;
    candidate.covered_by = owners.map(layout => layout.name || layout.path);
    for (const layout of owners) {
        const key = layout.name || layout.path;
        if (!ownership.has(key)) ownership.set(key, []);
        ownership.get(key).push(candidate.source_file);
    }
    candidate.ignored = ignoreReason;
    if (owners.length > 1) errors.push(
        `runtime mount '${candidate.source_file}' is owned by multiple runtime_chrome layouts: ${candidate.covered_by.join(', ')}`);
    if (owners.length && ignoreReason) errors.push(
        `runtime mount '${candidate.source_file}' cannot be both owned and ignored`);
    if (!owners.length && !ignoreReason) errors.push(
        `runtime mount '${candidate.source_file}' is not owned by a distinct runtime_chrome layout and has no reasoned ignore entry`);
}

for (const [owner, mounts] of ownership) {
    if (mounts.length > 1) errors.push(
        `runtime_chrome layout '${owner}' combines distinct mount files (${mounts.join(', ')}); give each mount its own layout/recipe`);
}

for (const item of validIgnored) {
    const rel = item && norm(item.source_file);
    if (!rel || !candidates.some(candidate => candidate.source_file === rel)) errors.push(
        `runtime_surface_coverage.ignored references a file that is not a detected runtime mount: ${(item && item.source_file) || '?'}`);
}

const report = { checked: true, candidates, ignored: validIgnored, errors, all_passed: errors.length === 0 };
if (reportPath) {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
}
if (errors.length) {
    console.error(`Runtime surface coverage: FAIL (${errors.length} error(s))`);
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
}
console.log(`Runtime surface coverage: OK (${candidates.length} mount(s), ${validIgnored.length} ignored)`);
