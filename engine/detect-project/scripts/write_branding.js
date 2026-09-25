#!/usr/bin/env node
'use strict';

/*
 * write_branding.js — write or patch branding.json for each app type, so the
 * detect-project steps need no inline Python.
 *
 * Usage:
 *   node write_branding.js web      <brand_dir> <compilation_method> <css_bytes>
 *        (merges <brand_dir>/branding-detect.json into <brand_dir>/branding.json)
 *   node write_branding.js terminal <branding.json> <theme_attr> <background> <accent> <css_bytes>
 *   node write_branding.js mobile   <branding.json> <platform> <platform_attr> <primary> <background> <css_bytes>
 *   node write_branding.js desktop  <branding.json> <platform> <window_chrome> <css_bytes>   (patch)
 *   node write_branding.js win32    <branding.json> <css_bytes>
 *   node write_branding.js macos    <branding.json> <css_bytes>
 *   node write_branding.js game     <branding.json> <engine> <logical_w> <logical_h> <display_w> <display_h> <css_bytes>   (patch)
 */

const fs = require('fs');
const path = require('path');

function int(value, name) {
    const text = String(value ?? '').trim();
    if (!/^-?\d+$/.test(text)) throw new Error(`${name} must be an integer, got "${value}"`);
    return Number(text);
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function now() {
    return new Date().toISOString();
}

const MODES = {
    web: ([brandDir, method, cssBytes]) => {
        const result = { ...readJson(path.join(brandDir, 'branding-detect.json')) };
        result.compiled_css_path = 'branding.css';
        result.compilation_method = method;
        result.compiled_css_bytes = int(cssBytes, 'css_bytes');
        result.generated_at = now().replace(/\.\d{3}Z$/, 'Z');
        return [path.join(brandDir, 'branding.json'), result];
    },
    terminal: ([file, attr, background, accent, cssBytes]) => [file, {
        framework: 'terminal',
        app_type: 'terminal',
        compiled_css_path: 'branding.css',
        compilation_method: 'webtui_vendored',
        compiled_css_bytes: int(cssBytes, 'css_bytes'),
        terminal_theme: attr,
        default_colors: { primary: accent, background },
        generated_at: now(),
    }],
    mobile: ([file, platform, attr, primary, background, cssBytes]) => [file, {
        framework: 'mobile',
        app_type: 'mobile',
        compiled_css_path: 'branding.css',
        compilation_method: 'framework7_vendored',
        compiled_css_bytes: int(cssBytes, 'css_bytes'),
        platform,
        platform_attr: attr,
        mobile_theme: 'light',
        default_colors: { primary, background },
        generated_at: now(),
    }],
    desktop: ([file, platform, chrome, cssBytes]) => {
        const branding = readJson(file);
        branding.app_type = 'desktop';
        branding.platform = platform; // macos | windows
        branding.window_chrome = chrome; // native | hybrid | custom (main window)
        branding.compiled_css_bytes = int(cssBytes, 'css_bytes');
        return [file, branding];
    },
    win32: ([file, cssBytes]) => [file, {
        framework: 'win32',
        app_type: 'win32',
        compiled_css_path: 'branding.css',
        compilation_method: '7css_vendored',
        compiled_css_bytes: int(cssBytes, 'css_bytes'),
        platform: 'windows',
        default_colors: { primary: '#3399ff', background: '#f0f0f0', confidence: 'low' },
        generated_at: now(),
    }],
    macos: ([file, cssBytes]) => [file, {
        framework: 'macos',
        app_type: 'macos',
        compiled_css_path: 'branding.css',
        compilation_method: 'puppertino_vendored',
        compiled_css_bytes: int(cssBytes, 'css_bytes'),
        platform: 'macos',
        default_colors: { primary: '#007aff', background: '#f6f6f6', confidence: 'low' },
        generated_at: now(),
    }],
    game: ([file, engine, lw, lh, dw, dh, cssBytes]) => {
        const branding = readJson(file);
        branding.app_type = 'game';
        branding.engine = engine;
        branding.canvas_size = { width: int(lw, 'logical_w'), height: int(lh, 'logical_h') };
        branding.display_size = { width: int(dw, 'display_w'), height: int(dh, 'display_h') };
        branding.compiled_css_bytes = int(cssBytes, 'css_bytes');
        return [file, branding];
    },
};

const ARITY = { web: 3, terminal: 5, mobile: 6, desktop: 4, win32: 2, macos: 2, game: 7 };

function main(argv) {
    const [mode, ...args] = argv;
    if (!MODES[mode] || args.length !== ARITY[mode]) {
        process.stderr.write('Usage: write_branding.js <web|terminal|mobile|desktop|win32|macos|game> <args…> (see the header)\n');
        return 2;
    }
    const [file, value] = MODES[mode](args);
    writeJson(file, value);
    return 0;
}

if (require.main === module) {
    try { process.exitCode = main(process.argv.slice(2)); }
    catch (error) {
        process.stderr.write(`write_branding: ${error.message}\n`);
        process.exitCode = 1;
    }
}
