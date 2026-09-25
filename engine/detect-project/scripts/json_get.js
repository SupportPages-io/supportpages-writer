#!/usr/bin/env node
'use strict';

/*
 * json_get.js — read values from a JSON file for shell scripts and SKILL.md
 * steps, so the skills need Node only (no jq).
 *
 * A path is dot-separated keys; a segment ending in [] iterates an array or
 * object's values ("reasons[].code"). "." is the whole document. Like jq's
 * `//`, null, false and missing values fall back to the default.
 *
 * Usage:
 *   node json_get.js <file> <path> [default]     print a value (arrays: one item per line)
 *   node json_get.js --length <file> <path>      print the length (0 when missing)
 *   node json_get.js --join <sep> <file> <path>  join the values with <sep>
 *   node json_get.js --count <file> <path> <key>=<value>
 *                                                count values whose <key> equals <value>
 *   node json_get.js --exists <file> <path>      exit 0 when present and not null/false
 *   node json_get.js --valid <file>...           exit 0 when every file parses as JSON
 *
 * A missing path with no default prints "null", as jq -r does.
 */

const fs = require('fs');

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Resolve a path to its list of values (more than one when a segment iterates). */
function resolve(doc, path) {
    let values = [doc];
    if (path === '.' || path === '') return values;
    for (const raw of path.replace(/^\./, '').split('.')) {
        const iterate = raw.endsWith('[]');
        const key = iterate ? raw.slice(0, -2) : raw;
        const next = [];
        for (const value of values) {
            const child = key === '' ? value : lookup(value, key);
            if (!iterate) next.push(child);
            else if (Array.isArray(child)) next.push(...child);
            else if (child !== null && typeof child === 'object') next.push(...Object.values(child));
        }
        values = next;
    }
    return values;
}

function lookup(value, key) {
    if (Array.isArray(value) && /^\d+$/.test(key)) return value[Number(key)];
    if (value !== null && typeof value === 'object' && Object.hasOwn(value, key)) return value[key];
    return undefined;
}

function present(value) {
    return value !== undefined && value !== null && value !== false;
}

function format(value) {
    if (value === undefined || value === null) return 'null';
    if (typeof value === 'string') return value;
    if (typeof value === 'object') return JSON.stringify(value, null, 2);
    return String(value);
}

function lengthOf(value) {
    if (Array.isArray(value) || typeof value === 'string') return value.length;
    if (value !== null && typeof value === 'object') return Object.keys(value).length;
    return 0;
}

function main(argv) {
    const mode = argv[0]?.startsWith('--') ? argv.shift() : '--get';
    const out = text => process.stdout.write(text + '\n');

    switch (mode) {
        case '--get': {
            const [file, path, fallback] = argv;
            if (!file || !path) usage();
            const values = resolve(readJson(file), path).filter(present);
            if (values.length) {
                const [only] = values;
                out(values.length === 1 && Array.isArray(only) ? only.map(format).join('\n') : values.map(format).join('\n'));
            } else {
                out(fallback ?? 'null');
            }
            return 0;
        }
        case '--length': {
            const [file, path] = argv;
            if (!file || !path) usage();
            out(String(lengthOf(resolve(readJson(file), path)[0])));
            return 0;
        }
        case '--join': {
            const [sep, file, path] = argv;
            if (sep === undefined || !file || !path) usage();
            out(resolve(readJson(file), path).filter(present).map(format).join(sep));
            return 0;
        }
        case '--count': {
            const [file, path, condition] = argv;
            if (!file || !path || !condition?.includes('=')) usage();
            const [key, expected] = [condition.slice(0, condition.indexOf('=')), condition.slice(condition.indexOf('=') + 1)];
            const matches = resolve(readJson(file), path).filter(value => format(lookup(value, key)) === expected);
            out(String(matches.length));
            return 0;
        }
        case '--exists': {
            const [file, path] = argv;
            if (!file || !path) usage();
            try { return resolve(readJson(file), path).some(present) ? 0 : 1; }
            catch { return 1; }
        }
        case '--valid': {
            if (!argv.length) usage();
            let status = 0;
            for (const file of argv) {
                try { readJson(file); }
                catch (error) { process.stderr.write(`${file}: ${error.message}\n`); status = 1; }
            }
            return status;
        }
        default:
            usage();
    }
}

function usage() {
    process.stderr.write('Usage: json_get.js [--length|--join <sep>|--count|--exists|--valid] <file> <path> [default]\n');
    process.exit(2);
}

if (require.main === module) {
    try { process.exitCode = main(process.argv.slice(2)); }
    catch (error) {
        process.stderr.write(`json_get: ${error.message}\n`);
        process.exitCode = 1;
    }
}

module.exports = { resolve, lengthOf };
