#!/usr/bin/env node
'use strict';

/*
 * sanitize_css.js — Strip un-compilable framework directives from a CSS file.
 *
 * When we fall back to inlining source CSS (rather than running the project's
 * build pipeline), compile-time directives like @tailwind, @apply, @theme,
 * @plugin, @custom-variant, @config, @source, @utility, @layer, and
 * @import "tailwindcss" leak into the output. Browsers can't parse those —
 * they silently break styling for everything after the first malformed rule.
 * This sanitizer strips them in place.
 *
 * Usage: node sanitize_css.js <css_file>
 */

const fs = require('fs');

const BAD_DIRECTIVES = [
    /^@tailwind\b[^;]*;?\s*$/,
    /^@theme\b/,
    /^@plugin\b[^;]*;?\s*$/,
    /^@custom-variant\b[^;]*;?\s*$/,
    /^@apply\b[^;]*;?\s*$/,
    /^@config\b[^;]*;?\s*$/,
    /^@source\b[^;]*;?\s*$/,
    /^@utility\b/,
    /^@import\s+["']tailwindcss[^;]*;?\s*$/,
];

function count(text, ch) {
    return text.split(ch).length - 1;
}

/** Return { cleaned, removed }. */
function sanitize(css) {
    const cleaned = [];
    let removed = 0;
    let skipDepth = 0; // brace depth for multi-line blocks like @theme { ... }

    for (const line of css.split('\n')) {
        const stripped = line.trim();

        if (skipDepth > 0) {
            skipDepth += count(stripped, '{') - count(stripped, '}');
            removed += 1;
            continue;
        }

        if (BAD_DIRECTIVES.some(pattern => pattern.test(stripped))) {
            removed += 1;
            if (stripped.includes('{')) skipDepth = count(stripped, '{') - count(stripped, '}');
            continue;
        }

        cleaned.push(line);
    }

    return { cleaned: cleaned.join('\n'), removed };
}

function main() {
    if (process.argv.length !== 3) {
        process.stderr.write('Usage: sanitize_css.js <css_file>\n');
        process.exit(1);
    }

    const cssFile = process.argv[2];
    const css = fs.readFileSync(cssFile, 'utf8');
    const { cleaned, removed } = sanitize(css);

    if (removed > 0) {
        fs.writeFileSync(cssFile, cleaned);
        process.stderr.write(`Sanitized ${cssFile}: removed ${removed} directive line(s) ` +
            `(${[...css].length} → ${[...cleaned].length} bytes)\n`);
    } else {
        process.stderr.write('CSS clean — no directives to remove\n');
    }
}

if (require.main === module) main();

module.exports = { sanitize };
