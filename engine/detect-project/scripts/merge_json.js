#!/usr/bin/env node
'use strict';

/*
 * merge_json.js — deep-merge a JSON patch into a JSON file in place.
 *
 * Objects merge key by key; arrays and scalars in the patch replace the
 * target's value. Keys absent from the patch are kept, so stamped fields such
 * as app_type/app_type_source survive an enrichment merge. A null in the patch
 * sets the key to null (it does not delete it).
 *
 * Usage:
 *   node merge_json.js <target.json> <patch.json>
 *   node merge_json.js <target.json> -        (patch on stdin)
 */

const fs = require('fs');

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function merge(target, patch) {
    if (!isObject(target) || !isObject(patch)) return patch;
    const result = { ...target };
    for (const [key, value] of Object.entries(patch)) {
        result[key] = isObject(value) && isObject(result[key]) ? merge(result[key], value) : value;
    }
    return result;
}

function main(argv) {
    const [targetFile, patchFile] = argv;
    if (!targetFile || !patchFile) {
        process.stderr.write('Usage: merge_json.js <target.json> <patch.json|->\n');
        return 2;
    }
    const target = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
    const patch = JSON.parse(fs.readFileSync(patchFile === '-' ? 0 : patchFile, 'utf8'));
    fs.writeFileSync(targetFile, JSON.stringify(merge(target, patch), null, 2) + '\n');
    return 0;
}

if (require.main === module) {
    try { process.exitCode = main(process.argv.slice(2)); }
    catch (error) {
        process.stderr.write(`merge_json: ${error.message}\n`);
        process.exitCode = 1;
    }
}

module.exports = { merge };
