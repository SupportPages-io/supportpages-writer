#!/usr/bin/env node
'use strict';

// Semantic quality checks for schema-v5 runtime recipes. Coverage answers
// "does every mount have a recipe?"; this gate answers "is the recipe concrete,
// internally consistent, and source-backed enough to render faithfully?"

const fs = require('fs');
const path = require('path');

function die(message) {
    console.error(`ERROR: ${message}`);
    process.exit(2);
}

const mapArg = process.argv[2];
const projectArg = process.argv[3];
const jsonIndex = process.argv.indexOf('--json');
const reportArg = jsonIndex >= 0 ? process.argv[jsonIndex + 1] : null;
if (!mapArg || !projectArg) die('usage: check_runtime_recipe_quality.js <project_map.json> <project_dir> [--json report.json]');

const projectDir = path.resolve(projectArg);
let projectMap;
try {
    projectMap = JSON.parse(fs.readFileSync(mapArg, 'utf8'));
} catch (error) {
    die(`cannot read project map: ${error.message}`);
}

function nonempty(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

function filePath(value) {
    if (!nonempty(value)) return null;
    const clean = value.replace(/^\.\//, '').split(/[?#]/, 1)[0];
    const absolute = path.resolve(projectDir, clean);
    const root = `${projectDir}${path.sep}`;
    if (!absolute.startsWith(root)) return null;
    try {
        if (!fs.statSync(absolute).isFile()) return null;
    } catch (_) {
        return null;
    }
    return path.relative(projectDir, absolute).split(path.sep).join('/');
}

function strings(value) {
    return Array.isArray(value) ? value.filter(nonempty) : [];
}

function allSources(recipe) {
    return [recipe.source_files, ...(recipe.regions || []).map(region => region.source_files),
        ...(recipe.states || []).map(state => state.source_files)].flat().filter(nonempty);
}

function rootTokens(value) {
    if (Array.isArray(value)) return value.filter(nonempty);
    return nonempty(value) ? value.split(/\s+/).filter(Boolean) : [];
}

const errors = [];
const summaries = [];
const layouts = Array.isArray(projectMap.layouts) ? projectMap.layouts : [];
const routes = projectMap.route_index && typeof projectMap.route_index === 'object'
    ? Object.entries(projectMap.route_index) : [];

for (const layout of layouts.filter(item => item && item.runtime_chrome)) {
    const owner = layout.name || layout.path || '?';
    const recipe = layout.runtime_chrome;
    const regions = Array.isArray(recipe.regions) ? recipe.regions : [];
    const states = Array.isArray(recipe.states) ? recipe.states : [];
    const mount = filePath(layout.path);
    const leftNav = regions.find(region => region && region.placement === 'left'
        && /nav|destination/i.test(`${region.id || ''} ${region.region || ''}`));
    const toolbar = regions.find(region => region && region.placement === 'top');
    const canvas = regions.find(region => region && region.placement === 'canvas');
    const overlay = regions.find(region => region && String(region.placement || '').startsWith('overlay-'));
    const complexEditor = Boolean(leftNav && toolbar && canvas && overlay);

    const invalidSources = [...new Set(allSources(recipe).filter(source => !filePath(source)))];
    if (invalidSources.length) errors.push(
        `runtime_chrome layout '${owner}' source_files must be existing regular files, not directories or symbolic placeholders: ${invalidSources.join(', ')}`);

    if (recipe.source_kind === 'knowledge'
        && (!Array.isArray(projectMap.default_user_assumptions) || !projectMap.default_user_assumptions.length)) {
        errors.push(`knowledge-backed runtime_chrome layout '${owner}' requires explicit default_user_assumptions`);
    }

    const navAppearance = String(leftNav && leftNav.appearance || '');
    if (leftNav && !/\b(?:light|dark|black|white|#[0-9a-f]{3,8})\b/i.test(navAppearance)) errors.push(
        `runtime navigation '${leftNav.id || '?'}' must record a concrete light/dark or colour treatment`);

    const shellMode = `${layout.area || ''} ${recipe.mode_note || ''}`;
    const shellHidden = /fullscreen|full-screen|shell\s+(?:is\s+)?hidden|no\s+(?:classic\s+)?(?:admin\s+)?(?:menu|toolbar)|(?:menu|toolbar)[^.;]{0,30}hidden/i.test(shellMode);
    if (shellHidden) {
        if (!layout.root_classes || typeof layout.root_classes !== 'object') errors.push(
            `shell-hiding runtime_chrome layout '${owner}' requires resolved layout root_classes`);
        const appHtml = new Set(rootTokens(projectMap.app_shell && projectMap.app_shell.root_classes
            && projectMap.app_shell.root_classes.html));
        const layoutHtml = rootTokens(layout.root_classes && layout.root_classes.html);
        const leakedOffsets = layoutHtml.filter(token => appHtml.has(token)
            && /toolbar|admin-?bar|shell|header-offset/i.test(token));
        if (leakedOffsets.length) errors.push(
            `shell-hiding runtime_chrome layout '${owner}' retains app-shell offset class(es): ${leakedOffsets.join(', ')}`);
    }

    const matchingRoutes = routes.filter(([, route]) => route && (
        route.layout === owner || route.layout === layout.path || filePath(route.primary_view) === mount
        || filePath(route.controller) === mount || filePath(route.source_file) === mount));
    if (mount && !matchingRoutes.length) errors.push(
        `runtime_chrome layout '${owner}' has no route pointing to its mount`);

    if (complexEditor) {
        const toolbarItems = Array.isArray(toolbar.items) ? toolbar.items : [];
        const toolbarKinds = new Set(toolbarItems.map(item => item && item.kind));
        if (toolbarItems.length < 5 || !['identity', 'control-group', 'document-context', 'primary-action']
            .every(kind => toolbarKinds.has(kind))) errors.push(
            `complex editor '${owner}' toolbar must inventory identity, editing controls, concrete document context, view controls, and primary action as at least five items`);

        const canvasItems = Array.isArray(canvas.items) ? canvas.items : [];
        const canvasSources = [...new Set(strings(canvas.source_files).map(filePath).filter(Boolean))];
        if (canvas.content_mode === 'populated' && canvasItems.length < 3) errors.push(
            `populated complex-editor canvas '${canvas.id || '?'}' requires at least three source-backed anatomy items`);
        if (canvas.content_mode === 'populated' && canvasSources.filter(source => source !== mount).length < 2) errors.push(
            `populated complex-editor canvas '${canvas.id || '?'}' requires at least two concrete content source files beyond its runtime mount`);

        const documentItems = toolbarItems.filter(item => item && item.kind === 'document-context');
        const documentLabels = new Set(documentItems.flatMap(item => strings(item.required_strings)));
        const featureLabels = new Set(regions.flatMap(region => [region.region])
            .concat(leftNav ? strings(leftNav.ui_strings) : [])
            .filter(nonempty).map(value => value.toLowerCase()));
        for (const state of states.filter(state => state && ['action', 'confirm'].includes(state.kind)
            && strings(state.visible_regions).includes(toolbar.id))) {
            const context = String(state.context_label || '').trim();
            if (!documentLabels.has(context)) errors.push(
                `runtime state '${state.id || '?'}' context_label '${context || '?'}' must match the toolbar document-context item`);
            if (featureLabels.has(context.toLowerCase())
                || /^(?:home|page|document|template|editor|content|design|styles?|settings|untitled)$/i.test(context)) errors.push(
                `runtime state '${state.id || '?'}' context_label '${context}' is a generic feature label, not a concrete open document/template title`);
        }

        const actionCount = states.filter(state => state && state.kind === 'action').length;
        const overlayItems = Array.isArray(overlay.items) ? overlay.items : [];
        const groups = overlayItems.filter(item => item && item.kind === 'group-heading');
        const selections = overlayItems.filter(item => item && item.kind === 'selection-row');
        const expectedGroups = Math.min(2, actionCount);
        if (groups.length < expectedGroups || selections.length < expectedGroups) errors.push(
            `complex editor '${owner}' confirmation must inventory at least ${expectedGroups} changed-entity group(s) and selection row(s), matching its action families`);
        for (const item of selections) {
            const labels = strings(item.required_strings);
            if (!labels.length || labels.every(value => /^(?:custom\s+)?(?:styles?|templates?|changes?|settings?)$/i.test(value))) errors.push(
                `confirmation selection '${item.id || '?'}' requires a concrete entity name, not a generic change label`);
        }

        for (const [key, route] of matchingRoutes) {
            const partials = strings(route.partials_expanded);
            const invalidPartials = partials.filter(partial => !filePath(partial));
            if (!partials.length || invalidPartials.length) errors.push(
                `runtime route '${key}' for complex editor '${owner}' requires recursively expanded regular-file partials`);
            const closure = new Set([route.primary_view, route.controller_action, ...partials]
                .map(filePath).filter(Boolean));
            const missingCanvas = canvasSources.filter(source => !closure.has(source));
            if (missingCanvas.length) errors.push(
                `runtime route '${key}' partial closure omits canvas source(s): ${missingCanvas.join(', ')}`);
        }
    }

    summaries.push({ layout: owner, complex_editor: complexEditor, sources: new Set(allSources(recipe)).size,
        regions: regions.length, states: states.length });
}

const report = { checked: true, summaries, errors, all_passed: errors.length === 0 };
if (reportArg) {
    const reportPath = path.resolve(reportArg);
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}
if (errors.length) {
    console.error(`Runtime recipe quality: FAIL (${errors.length} error(s))`);
    errors.forEach(error => console.error(`  - ${error}`));
    process.exit(1);
}
console.log(`Runtime recipe quality: OK (${summaries.length} recipe(s))`);
