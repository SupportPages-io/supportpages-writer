#!/usr/bin/env node
'use strict';

/*
 * recommend_model_tier.js — classify the model capability needed for mockups.
 *
 * This is deliberately a cache-only postprocessor. detect-project has already
 * paid the cost of resolving routes, chrome, runtime editors, and CSS health;
 * repeating that exploration in another skill would waste both time and model
 * tokens. The parent application maps low/medium/high to current model IDs.
 *
 * Usage:
 *   node recommend_model_tier.js <project_map.json> <branding.json>
 */

const fs = require('fs');
const path = require('path');

const POLICY_VERSION = 'heuristic-v1';
const VALID_APP_TYPES = new Set(['web', 'terminal', 'mobile', 'desktop', 'win32', 'macos', 'game']);
const SPECIALIZED_APP_TYPES = new Set(['terminal', 'mobile', 'desktop', 'win32', 'macos']);
const SHELL_REGION_KEYS = [
    'top_bar', 'titlebar', 'menu_bar', 'global_sidebar', 'primary_sidebar',
    'secondary_sidebar', 'statusbar', 'toolbar', 'account_area',
];
const INDEX_KEYS = ['route_index', 'screen_index', 'command_index', 'dialog_index', 'view_index'];

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function objectValues(value) {
    return isObject(value) ? Object.values(value) : [];
}

function indexCount(map) {
    return Math.max(0, ...INDEX_KEYS.map(key => objectValues(map[key]).length));
}

function shellMetrics(shell) {
    if (!isObject(shell)) return { navItems: 0, persistentRegions: 0 };
    const navItems = Array.isArray(shell.nav_items) ? shell.nav_items.length : 0;
    const persistentRegions = SHELL_REGION_KEYS.filter(key => {
        const value = shell[key];
        if (Array.isArray(value)) return value.length > 0;
        if (isObject(value)) return Object.keys(value).length > 0;
        return typeof value === 'string' ? value.trim().length > 0 : Boolean(value);
    }).length;
    return { navItems, persistentRegions };
}

function maxSourceFanout(map) {
    let max = 0;
    for (const key of INDEX_KEYS) {
        for (const entry of objectValues(map[key])) {
            if (!isObject(entry)) continue;
            const expanded = Array.isArray(entry.partials_expanded) ? entry.partials_expanded.length : 0;
            max = Math.max(max, expanded);
        }
    }
    return max;
}

function runtimeMetrics(map) {
    const layouts = Array.isArray(map.layouts) ? map.layouts : [];
    const recipes = layouts
        .map(layout => isObject(layout) ? layout.runtime_chrome : null)
        .filter(isObject);
    let maxRegions = 0;
    let maxStates = 0;
    let populatedCanvas = false;
    for (const recipe of recipes) {
        const regions = Array.isArray(recipe.regions) ? recipe.regions : [];
        const states = Array.isArray(recipe.states) ? recipe.states : [];
        maxRegions = Math.max(maxRegions, regions.length);
        maxStates = Math.max(maxStates, states.length);
        populatedCanvas ||= regions.some(region => isObject(region)
            && region.placement === 'canvas'
            && (region.content_mode === 'populated' || region.media_expectation === 'required'));
    }
    return { count: recipes.length, maxRegions, maxStates, populatedCanvas };
}

function hasCanvasSceneAnatomy(map, appType) {
    if (appType !== 'game') return false;
    return objectValues(map.route_index).some(entry => isObject(entry)
        && entry.method === 'CANVAS'
        && isObject(entry.scene_anatomy)
        && Array.isArray(entry.scene_anatomy.layers)
        && entry.scene_anatomy.layers.length > 0);
}

function normalizedFramework(map, branding) {
    const raw = map.framework || branding.framework || '';
    return String(raw).trim().toLowerCase();
}

function isKnownWebFramework(framework) {
    return Boolean(framework) && !['custom', 'unknown', 'none', '?'].includes(framework);
}

function classify(projectMap, branding = {}) {
    if (!isObject(projectMap)) throw new Error('project map must be a JSON object');
    if (!isObject(branding)) throw new Error('branding cache must be a JSON object');

    const framework = normalizedFramework(projectMap, branding);
    const rawAppType = typeof projectMap.app_type === 'string'
        ? projectMap.app_type.trim().toLowerCase() : '';
    // Older web caches predate app_type. Preserve their useful classification
    // when a known web framework makes the intended surface unambiguous.
    const appType = rawAppType || (isKnownWebFramework(framework) ? 'web' : '');
    const layouts = Array.isArray(projectMap.layouts) ? projectMap.layouts.length : 0;
    const surfaces = indexCount(projectMap);
    const shell = shellMetrics(projectMap.app_shell);
    const sourceFanout = maxSourceFanout(projectMap);
    const runtime = runtimeMetrics(projectMap);
    const fallbackCss = branding.compilation_method === 'fallback_synthesis'
        || (isObject(projectMap.css_build) && projectMap.css_build.method === 'fallback_synthesis');

    let score = 0;
    let hardHigh = false;
    let mediumFloor = false;
    const reasons = [];
    const add = (code, weight, evidence, options = {}) => {
        score += weight;
        reasons.push({ code, weight, evidence });
        hardHigh ||= Boolean(options.hardHigh);
        mediumFloor ||= Boolean(options.mediumFloor);
    };

    const complexRuntime = runtime.count > 0
        && (runtime.maxRegions >= 4 || runtime.maxStates >= 3 || runtime.populatedCanvas);
    if (complexRuntime) {
        add('complex_runtime_surface', 7, {
            recipe_count: runtime.count,
            max_regions: runtime.maxRegions,
            max_states: runtime.maxStates,
            populated_canvas: runtime.populatedCanvas,
        }, { hardHigh: true });
    } else if (runtime.count > 0) {
        add('runtime_mounted_ui', 3, { recipe_count: runtime.count }, { mediumFloor: true });
    }

    if (hasCanvasSceneAnatomy(projectMap, appType)) {
        add('canvas_scene_anatomy', 7, { app_type: appType }, { hardHigh: true });
    }

    const richDesktop = appType === 'desktop'
        && surfaces >= 8
        && shell.persistentRegions >= 3;
    if (richDesktop) {
        add('rich_desktop_workspace', 7, {
            surface_count: surfaces,
            persistent_shell_regions: shell.persistentRegions,
        }, { hardHigh: true });
    } else if (SPECIALIZED_APP_TYPES.has(appType)) {
        add('specialized_app_surface', 2, { app_type: appType }, { mediumFloor: true });
    }

    if (fallbackCss) {
        add('fallback_css_synthesis', 2, {
            compilation_method: 'fallback_synthesis',
        }, { mediumFloor: true });
    }

    if (appType === 'web' && !isKnownWebFramework(framework)) {
        add('custom_or_unknown_web_framework', 2, {
            framework: framework || null,
        }, { mediumFloor: true });
    }

    if (!VALID_APP_TYPES.has(appType)) {
        add('unknown_project_surface', 3, {
            app_type: rawAppType || null,
            framework: framework || null,
        }, { mediumFloor: true });
    }

    if (sourceFanout >= 8) {
        add('deep_source_fanout', 2, { max_partials_expanded: sourceFanout });
    }
    if (layouts >= 5) add('multiple_layouts', 1, { layout_count: layouts });
    if (surfaces >= 25) add('many_user_surfaces', 1, { surface_count: surfaces });
    if (shell.navItems >= 8 || shell.persistentRegions >= 3) {
        add('complex_persistent_shell', 1, {
            nav_item_count: shell.navItems,
            persistent_region_count: shell.persistentRegions,
        });
    }

    let tier = score >= 7 ? 'high' : score >= 3 ? 'medium' : 'low';
    if (hardHigh) tier = 'high';
    else if (mediumFloor && tier === 'low') tier = 'medium';

    if (reasons.length === 0) {
        reasons.push({
            code: 'straightforward_project_structure',
            weight: 0,
            evidence: { app_type: appType || null, framework: framework || null },
        });
    }

    return {
        schema_version: 1,
        policy_version: POLICY_VERSION,
        tier,
        score,
        source: 'heuristic',
        reasons,
    };
}

function readJson(file, label) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        throw new Error(`cannot read ${label} '${file}': ${error.message}`);
    }
}

function writeJsonAtomic(file, value) {
    const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
    fs.renameSync(temp, file);
}

function main() {
    const [mapArg, brandingArg] = process.argv.slice(2);
    if (!mapArg || !brandingArg) {
        console.error('Usage: node recommend_model_tier.js <project_map.json> <branding.json>');
        process.exit(1);
    }
    try {
        const mapPath = path.resolve(mapArg);
        const brandingPath = path.resolve(brandingArg);
        const map = readJson(mapPath, 'project map');
        const branding = readJson(brandingPath, 'branding cache');
        map.mockup_model_recommendation = classify(map, branding);
        writeJsonAtomic(mapPath, map);
        const recommendation = map.mockup_model_recommendation;
        const reasonCodes = recommendation.reasons.map(reason => reason.code).join(', ');
        console.log(`mockup model tier: ${recommendation.tier} `
            + `(score ${recommendation.score}; ${reasonCodes})`);
    } catch (error) {
        console.error(`ERROR: ${error.message}`);
        process.exit(1);
    }
}

if (require.main === module) main();

module.exports = { classify, POLICY_VERSION };
