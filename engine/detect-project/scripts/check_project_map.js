#!/usr/bin/env node
'use strict';

/*
 * check_project_map.js — validate project_map.json for an app type before the
 * summary step. Replaces the jq gates, and names every failing field instead
 * of printing a bare "false".
 *
 * Usage:
 *   node check_project_map.js <web|terminal|mobile|desktop|win32|macos|game> <project_map.json> [codebase_dir]
 *
 * For web, a codebase_dir containing config/routes.rb also requires a
 * non-empty route_index. Exits 0 when valid, 1 with one problem per line.
 */

const fs = require('fs');
const path = require('path');

const PLACEMENTS = new Set(['top', 'left', 'right', 'bottom', 'canvas', 'overlay-left', 'overlay-right', 'overlay-center', 'overlay-bottom']);
const STATE_KINDS = new Set(['overview', 'action', 'confirm']);
const PRIORITIES = new Set(['orientation', 'primary-action', 'secondary-action', 'terminal-action']);

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isString = value => typeof value === 'string';
const nonEmptyString = value => isString(value) && value.length > 0;
const nonEmptyArray = value => Array.isArray(value) && value.length > 0;
const nonEmptyObject = value => isObject(value) && Object.keys(value).length > 0;

function checkRuntimeChrome(chrome, where, problems) {
    const fail = message => problems.push(`${where}: ${message}`);
    if (chrome.source_kind !== 'repo' && chrome.source_kind !== 'knowledge') fail('source_kind must be "repo" or "knowledge"');
    if (!Array.isArray(chrome.source_files)) fail('source_files must be an array');
    if (!nonEmptyArray(chrome.regions)) fail('regions must be a non-empty array');
    if (!nonEmptyArray(chrome.states)) fail('states must be a non-empty array');

    (Array.isArray(chrome.regions) ? chrome.regions : []).forEach((region, i) => {
        const at = `regions[${i}]`;
        if (!isObject(region)) return fail(`${at} must be an object`);
        if (!nonEmptyString(region.id)) fail(`${at}.id must be a non-empty string`);
        if (!PLACEMENTS.has(region.placement)) fail(`${at}.placement must be one of ${[...PLACEMENTS].join(', ')}`);
        if (typeof region.required !== 'boolean') fail(`${at}.required must be a boolean`);
        if (!nonEmptyString(region.appearance)) fail(`${at}.appearance must be a non-empty string`);
        if (!nonEmptyArray(region.items)) fail(`${at}.items must be a non-empty array`);
        (Array.isArray(region.items) ? region.items : []).forEach((item, j) => {
            const it = `${at}.items[${j}]`;
            if (!isObject(item)) return fail(`${it} must be an object`);
            for (const key of ['id', 'kind', 'description']) if (!nonEmptyString(item[key])) fail(`${it}.${key} must be a non-empty string`);
            if (!Array.isArray(item.required_strings)) fail(`${it}.required_strings must be an array`);
        });
        if (!Array.isArray(region.required_strings)) fail(`${at}.required_strings must be an array`);
        if (!Array.isArray(region.source_files)) fail(`${at}.source_files must be an array`);
    });

    const states = Array.isArray(chrome.states) ? chrome.states : [];
    states.forEach((state, i) => {
        const at = `states[${i}]`;
        if (!isObject(state)) return fail(`${at} must be an object`);
        if (!nonEmptyString(state.id)) fail(`${at}.id must be a non-empty string`);
        if (!STATE_KINDS.has(state.kind)) fail(`${at}.kind must be one of ${[...STATE_KINDS].join(', ')}`);
        if (!nonEmptyArray(state.topic_tags)) fail(`${at}.topic_tags must be a non-empty array`);
        if (!PRIORITIES.has(state.instructional_priority)) fail(`${at}.instructional_priority must be one of ${[...PRIORITIES].join(', ')}`);
        if (!nonEmptyString(state.canvas_presentation)) fail(`${at}.canvas_presentation must be a non-empty string`);
        if ((state.kind === 'action' || state.kind === 'confirm') && !nonEmptyString(state.context_label)) {
            fail(`${at}.context_label must be a non-empty string for ${state.kind} states`);
        }
        if (typeof state.screenshot_required !== 'boolean') fail(`${at}.screenshot_required must be a boolean`);
        if (!nonEmptyArray(state.visible_regions)) fail(`${at}.visible_regions must be a non-empty array`);
        for (const key of ['required_regions', 'required_strings', 'source_files']) {
            if (!Array.isArray(state[key])) fail(`${at}.${key} must be an array`);
        }
    });
    const screenshots = states.filter(state => isObject(state) && state.screenshot_required).length;
    if (screenshots > 3) fail(`at most 3 states may set screenshot_required (found ${screenshots})`);
}

function checkIndexedApp(map, appType, indexKey, metadataKey, problems) {
    if (!nonEmptyObject(map[indexKey])) problems.push(`${indexKey} must be a non-empty object`);
    if (!isObject(map[metadataKey])) problems.push(`${metadataKey} must be an object`);
    if (!Object.hasOwn(map, 'app_shell')) problems.push('app_shell is missing');
}

const CHECKS = {
    web(map, problems, codebase) {
        if (map.schema_version !== 5) problems.push('schema_version must be 5');
        if (!isObject(map.dir_map)) problems.push('dir_map must be an object');
        if (!nonEmptyArray(map.layouts)) problems.push('layouts must be a non-empty array');
        (Array.isArray(map.layouts) ? map.layouts : []).forEach((layout, i) => {
            if (isObject(layout) && layout.runtime_chrome != null) {
                if (!isObject(layout.runtime_chrome)) problems.push(`layouts[${i}].runtime_chrome must be an object`);
                else checkRuntimeChrome(layout.runtime_chrome, `layouts[${i}].runtime_chrome`, problems);
            }
        });
        if (codebase && fs.existsSync(path.join(codebase, 'config', 'routes.rb')) && !nonEmptyObject(map.route_index)) {
            problems.push('route_index must be a non-empty object (config/routes.rb exists)');
        }
    },
    terminal(map, problems) {
        if (!nonEmptyObject(map.command_index)) problems.push('command_index must be a non-empty object');
        if (!isObject(map.cli_metadata)) problems.push('cli_metadata must be an object');
    },
    mobile: (map, problems) => checkIndexedApp(map, 'mobile', 'screen_index', 'mobile_metadata', problems),
    desktop: (map, problems) => checkIndexedApp(map, 'desktop', 'route_index', 'desktop_metadata', problems),
    win32: (map, problems) => checkIndexedApp(map, 'win32', 'dialog_index', 'win32_metadata', problems),
    macos: (map, problems) => checkIndexedApp(map, 'macos', 'view_index', 'macos_metadata', problems),
    game(map, problems) {
        if (!isObject(map.game_metadata)) problems.push('game_metadata must be an object');
        if (!nonEmptyObject(map.route_index)) problems.push('route_index must be a non-empty object');
        const canvas = Object.entries(isObject(map.route_index) ? map.route_index : {})
            .filter(([, entry]) => isObject(entry) && entry.method === 'CANVAS');
        if (!canvas.length) problems.push('route_index must contain at least one CANVAS state');
        for (const [key, entry] of canvas) {
            if (!nonEmptyArray(entry.scene_anatomy?.layers)) problems.push(`route_index.${key}.scene_anatomy.layers must be a non-empty array`);
        }
        if (!Object.hasOwn(map, 'app_shell')) problems.push('app_shell is missing');
    },
};

function check(mode, map, codebase) {
    const problems = [];
    if (!isObject(map)) return ['project_map must be a JSON object'];
    if (map.app_type !== mode) problems.push(`app_type must be "${mode}" (found ${JSON.stringify(map.app_type)})`);
    if (!isString(map.app_type_source)) problems.push('app_type_source must be a string');
    CHECKS[mode](map, problems, codebase);
    return problems;
}

function main(argv) {
    const [mode, file, codebase] = argv;
    if (!CHECKS[mode] || !file) {
        process.stderr.write(`Usage: check_project_map.js <${Object.keys(CHECKS).join('|')}> <project_map.json> [codebase_dir]\n`);
        return 2;
    }
    let map;
    try { map = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) {
        process.stderr.write(`${file}: ${error.message}\n`);
        return 1;
    }
    const problems = check(mode, map, codebase);
    if (problems.length) {
        process.stderr.write(`project_map.json is not valid for ${mode}:\n${problems.map(p => `  - ${p}`).join('\n')}\n`);
        return 1;
    }
    process.stdout.write(`project_map.json OK (${mode})\n`);
    return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { check };
