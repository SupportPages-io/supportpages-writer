#!/usr/bin/env node
/**
 * classify_workspace.js — run classify_surface.sh on every git checkout
 * directly under a multi-repo workspace root and print JSON:
 *
 *   [{ "directory": "acme-web", "surface": "web", "source": "auto", "reason": "…" }, …]
 *
 * Usage: node classify_workspace.js <repos_root>
 * Sorted by directory; prints [] for a missing root. Always exits 0.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'classify_surface.sh');

function classifyWorkspace(root) {
    if (!root || !fs.existsSync(root)) return [];
    return fs.readdirSync(root, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && fs.existsSync(path.join(root, entry.name, '.git')))
        .map(entry => entry.name)
        .sort()
        .map(directory => {
            let out = '';
            try { out = execFileSync('bash', [SCRIPT, path.join(root, directory)], { encoding: 'utf8' }); } catch { /* none below */ }
            const fields = Object.fromEntries(out.trim().split('\n').filter(Boolean).map(line => {
                const i = line.indexOf('=');
                return [line.slice(0, i), line.slice(i + 1)];
            }));
            return { directory, surface: fields.surface || 'none', source: fields.source || 'default', reason: fields.reason || '' };
        });
}

if (require.main === module) {
    process.stdout.write(JSON.stringify(classifyWorkspace(process.argv[2]), null, 2) + '\n');
}

module.exports = { classifyWorkspace };
