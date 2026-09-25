#!/usr/bin/env node
'use strict';

/*
 * extract_images.js — Walk a directory, find brand/UI images, output as base64 data URIs.
 *
 * Usage:
 *     node extract_images.js <repo_dir> <output_json> [--cache]
 *
 * Budget: 1MB per file, 10MB of base64 in total. Priority names (logo, brand,
 * favicon, …) are encoded first, then smaller files. No external deps.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_FILE_SIZE = 1024 * 1024;
const MAX_TOTAL_SIZE = 10 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico']);
const SKIP_DIRS = new Set([
    'node_modules', '.git', 'vendor', 'tmp', 'log', 'coverage',
    '.bundle', 'dist', 'build', '.next', '.nuxt', '__pycache__',
    '.cache', '.parcel-cache', 'bower_components', 'output',
    // The seeded cache holds card_bg.png / card_logo.* which are title-card
    // assets, not repo UI images — they must not enter the mockup image manifest.
    // (Harmless in article runs: an article codebase has no such cache assets.)
    '.rtfm', '.rtfm-branding',
]);
const PRIORITY_NAMES = ['logo', 'brand', 'favicon', 'icon', 'avatar', 'placeholder', 'default', 'hero'];

const MIME_MAP = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
    '.ico': 'image/x-icon',
};

/** Split an entry into files and directories the way a top-down walk sees them. */
function listDir(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return { dirs: [], files: [] }; }
    const dirs = [];
    const files = [];
    for (const entry of entries) {
        let isDir = entry.isDirectory();
        if (entry.isSymbolicLink()) {
            // A symlink to a directory is listed as a directory but never followed.
            try { isDir = fs.statSync(path.join(dir, entry.name)).isDirectory(); }
            catch { isDir = false; }
            if (isDir) continue;
        }
        (isDir ? dirs : files).push(entry.name);
    }
    return { dirs, files };
}

function walk(repoDir) {
    const found = [];
    const visit = dir => {
        const { dirs, files } = listDir(dir);
        for (const fname of files) {
            const ext = path.extname(fname).toLowerCase();
            if (!IMAGE_EXTENSIONS.has(ext)) continue;
            const fpath = path.join(dir, fname);
            let stat;
            try { stat = fs.statSync(fpath, { bigint: true }); }
            catch { continue; }
            const size = Number(stat.size);
            if (size > MAX_FILE_SIZE || size === 0) continue;
            const mtime = Number(stat.mtimeNs / 1000000000n);
            const relPath = path.relative(repoDir, fpath);
            const nameNoExt = path.basename(fname, path.extname(fname));
            // Skip fingerprinted/hashed copies (e.g. logo-abc123def456.png)
            if ([...nameNoExt].length > 40 && nameNoExt.includes('-')) {
                const tail = nameNoExt.slice(nameNoExt.lastIndexOf('-') + 1);
                if ([...tail].length > 20) continue;
            }
            const nameLower = nameNoExt.toLowerCase();
            found.push({
                relPath,
                absPath: fpath,
                size,
                mtime,
                ext,
                priority: PRIORITY_NAMES.some(name => nameLower.includes(name)),
            });
        }
        for (const name of dirs) {
            if (!SKIP_DIRS.has(name)) visit(path.join(dir, name));
        }
    };
    visit(repoDir);
    found.sort((a, b) => (Number(!a.priority) - Number(!b.priority)) || (a.size - b.size));
    return found;
}

/**
 * Content signature of the candidate image set: changes iff an image is
 * added, removed, resized, or modified. Cheap (stat-only) — lets a cached
 * manifest be reused across runs without re-reading/encoding the bytes.
 */
function signature(found) {
    const hash = crypto.createHash('sha256');
    for (const item of [...found].sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0))) {
        hash.update(`${item.relPath}:${item.size}:${item.mtime}\n`);
    }
    return hash.digest('hex');
}

function buildManifest(found) {
    const images = {};
    const unique = new Set();
    let totalB64Size = 0;

    for (const item of found) {
        let data;
        try { data = fs.readFileSync(item.absPath); }
        catch { continue; }
        const b64 = data.toString('base64');
        if (totalB64Size + b64.length > MAX_TOTAL_SIZE) continue;
        const mime = MIME_MAP[item.ext] ?? 'application/octet-stream';
        const dataUri = `data:${mime};base64,${b64}`;

        if (unique.has(dataUri)) {
            images[item.relPath] = dataUri;
            continue;
        }
        unique.add(dataUri);

        const rel = item.relPath;
        const fname = path.basename(rel);
        images[rel] = dataUri;
        images['/' + rel] = dataUri;
        images[fname] = dataUri;
        images['/' + fname] = dataUri;
        for (const prefix of ['/assets/', '/images/', '/img/', '/static/']) images[prefix + fname] = dataUri;

        totalB64Size += b64.length;
    }

    return { images, count: unique.size, totalB64Size };
}

function main(argv) {
    const useCache = argv.includes('--cache');
    const args = argv.filter(arg => arg !== '--cache');
    if (args.length !== 2) {
        process.stderr.write('Usage: extract_images.js <repo_dir> <output_json> [--cache]\n');
        return 1;
    }
    const [repoDir, outputFile] = args;
    if (!fs.existsSync(repoDir) || !fs.statSync(repoDir).isDirectory()) {
        process.stderr.write(`Error: ${repoDir} is not a directory\n`);
        return 1;
    }
    fs.mkdirSync(path.dirname(outputFile) || '.', { recursive: true });

    const found = walk(repoDir);
    const sig = signature(found);

    // Cache hit: existing manifest covers the same image set -> reuse, skip the
    // read+base64 work. The stat-only walk above is the only cost on a hit.
    if (useCache && fs.existsSync(outputFile)) {
        try {
            const prev = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
            if (prev.signature === sig && prev.images && Object.keys(prev.images).length) {
                process.stdout.write(`cache hit (${prev.count ?? '?'} images) -> ${outputFile}\n`);
                return 0;
            }
        } catch { /* rebuild */ }
    }

    const { images, count, totalB64Size } = buildManifest(found);
    fs.writeFileSync(outputFile, JSON.stringify({
        count,
        total_b64_bytes: totalB64Size,
        signature: sig,
        images,
    }));
    process.stdout.write(`${count} unique image(s), ${Math.floor(totalB64Size / 1024)}KB base64 -> ${outputFile}\n`);
    return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { walk, signature, buildManifest };
