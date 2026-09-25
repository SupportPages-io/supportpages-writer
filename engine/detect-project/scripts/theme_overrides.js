#!/usr/bin/env node
'use strict';

/*
 * theme_overrides.js — Given detection JSON + framework name, emit theme-aware
 * CSS overrides (CSS custom properties + component class overrides) on stdout.
 *
 * When source compilation fails and we fall back to a framework CDN, the
 * vanilla CDN doesn't know about the project's brand colours. This script
 * generates the targeted overrides so things like .btn-primary, --bs-primary,
 * and font-family settings render with the detected theme.
 *
 * Usage: node theme_overrides.js <detection_json> <framework>
 *        — writes the override CSS to stdout
 */

const fs = require('fs');

/** Python-style truthiness: empty strings, arrays and objects are false. */
function truthy(value) {
    if (Array.isArray(value)) return value.length > 0;
    if (value !== null && typeof value === 'object') return Object.keys(value).length > 0;
    return Boolean(value);
}

function orEmpty(value) {
    return truthy(value) ? value : {};
}

function hexToRgb(hex) {
    const h = String(hex).replace(/^#+/, '');
    if (h.length !== 6) return [0, 0, 0];
    // Throw on non-hex digits, as the caller treats a failed run as "no overrides".
    return [0, 2, 4].map(i => {
        const pair = h.slice(i, i + 2);
        if (!/^[0-9a-fA-F]{2}$/.test(pair)) throw new Error(`invalid hex colour: ${hex}`);
        return parseInt(pair, 16);
    });
}

function isValid(value) {
    return truthy(value) && value !== 'null' && value !== 'None';
}

function overrideCss(detect, framework) {
    // Detection JSON may have theme tokens at the top level (skill convention)
    // OR nested under theme_overrides (analyzer convention). Support both.
    const overrides = detect.theme_overrides ?? {};
    const colors = { ...orEmpty(overrides.colors) };
    const custom = orEmpty(overrides.custom_colors);
    const fonts = orEmpty(overrides.fonts);
    const radius = overrides.border_radius;

    // Skill-style fallback: pick up default_colors + scss_vars from top level
    if (!truthy(colors)) {
        const dc = orEmpty(detect.default_colors);
        // Translate {primary, accent} → {primary, secondary}
        if (truthy(dc.primary)) colors.primary = dc.primary;
        if (truthy(dc.accent)) colors.secondary = dc.accent;
        const sv = orEmpty(detect.scss_vars);
        for (const key of ['success', 'danger', 'warning', 'info', 'body-color']) {
            if (truthy(sv[key])) colors[key.replaceAll('-', '_')] = sv[key];
        }
    }

    const bodyFont = fonts.body;
    const headingFont = fonts.heading;
    const lines = ['', '/* Theme overrides from project variables */', ':root {'];

    if (framework === 'bootstrap') {
        for (const [name, val] of Object.entries(colors)) {
            if (!isValid(val)) continue;
            const [r, g, b] = hexToRgb(val);
            lines.push(`  --bs-${name}: ${val};`);
            lines.push(`  --bs-${name}-rgb: ${r}, ${g}, ${b};`);
        }
        if (isValid(bodyFont)) lines.push(`  --bs-body-font-family: ${bodyFont};`);
        if (isValid(headingFont)) lines.push(`  --bs-heading-font-family: ${headingFont};`);
        if (isValid(radius)) lines.push(`  --bs-border-radius: ${radius};`);
        lines.push('}');

        for (const [name, val] of Object.entries(custom)) {
            if (!isValid(val)) continue;
            const safe = name.replaceAll('_', '-');
            lines.push(`.text-${safe} { color: ${val} !important; }`);
            lines.push(`.bg-${safe} { background-color: ${val} !important; }`);
        }

        const primary = colors.primary;
        const secondary = colors.secondary;
        if (isValid(primary)) {
            lines.push(`.btn-primary { background-color: ${primary}; border-color: ${primary}; }`);
            lines.push(`.btn-primary:hover { background-color: ${primary}; border-color: ${primary}; opacity: 0.9; }`);
            lines.push(`.btn-outline-primary { color: ${primary}; border-color: ${primary}; }`);
            lines.push(`.btn-outline-primary:hover { background-color: ${primary}; border-color: ${primary}; color: #fff; }`);
            lines.push(`a { color: ${primary}; }`);
            lines.push(`.text-primary { color: ${primary} !important; }`);
            lines.push(`.bg-primary { background-color: ${primary} !important; }`);
        }
        if (isValid(secondary)) {
            lines.push(`.btn-secondary { background-color: ${secondary}; border-color: ${secondary}; }`);
        }
    } else if (framework === 'tailwind') {
        for (const [name, val] of Object.entries(colors)) {
            if (isValid(val)) lines.push(`  --color-${name}: ${val};`);
        }
        if (isValid(bodyFont)) lines.push(`  font-family: ${bodyFont};`);
        if (isValid(headingFont)) lines.push(`  --font-heading: ${headingFont};`);
        if (isValid(radius)) lines.push(`  --radius: ${radius};`);
        lines.push('}');

        if (isValid(headingFont)) lines.push(`h1, h2, h3, h4, h5, h6 { font-family: ${headingFont}; }`);

        for (const [name, val] of Object.entries({ ...colors, ...custom })) {
            if (!isValid(val)) continue;
            const safe = name.replaceAll('_', '-');
            lines.push(`.text-${safe} { color: ${val}; }`);
            lines.push(`.bg-${safe} { background-color: ${val}; }`);
        }
    } else {
        // Generic: plain CSS custom properties + utility classes
        for (const [name, val] of Object.entries(colors)) {
            if (isValid(val)) lines.push(`  --color-${name}: ${val};`);
        }
        if (isValid(bodyFont)) lines.push(`  font-family: ${bodyFont};`);
        if (isValid(headingFont)) lines.push(`  --font-heading: ${headingFont};`);
        if (isValid(radius)) lines.push(`  --border-radius: ${radius};`);
        lines.push('}');

        for (const [name, val] of Object.entries(custom)) {
            if (!isValid(val)) continue;
            const safe = name.replaceAll('_', '-');
            lines.push(`.text-${safe} { color: ${val} !important; }`);
            lines.push(`.bg-${safe} { background-color: ${val} !important; }`);
        }
    }

    let out = lines.join('\n') + '\n';

    // Append sanitized extra_css if detection captured any
    const extra = overrides.extra_css ?? '';
    if (isValid(extra)) {
        const badPatterns = [
            /^@tailwind\b/, /^@theme\b/, /^@plugin\b/, /^@custom-variant\b/,
            /^@apply\b/, /^@config\b/, /^@source\b/, /^@utility\b/,
            /^@layer\b/, /^@import\s+["']tailwindcss/,
        ];
        const clean = String(extra).split('\n')
            .filter(line => !badPatterns.some(pattern => pattern.test(line.trim())))
            .join('\n').trim();
        if (clean) out += `\n/* Extra project overrides */\n${clean}\n`;
    }

    return out;
}

function main() {
    if (process.argv.length !== 4) {
        process.stderr.write('Usage: theme_overrides.js <detection_json> <framework>\n');
        process.exit(1);
    }
    const [detectPath, framework] = process.argv.slice(2);
    const detect = JSON.parse(fs.readFileSync(detectPath, 'utf8'));
    process.stdout.write(overrideCss(detect, framework));
}

if (require.main === module) main();

module.exports = { overrideCss };
