#!/usr/bin/env node
'use strict';

/*
 * trace_hook.js — PostToolUse hook for the rtfm-skills bundle.
 *
 * Logs every tool call the agent makes WHILE a skill run is active into a
 * project-local NDJSON trace, so runs can be diffed for repeated navigation.
 * The same hook serves generate-illustrated-article and generate-walkthrough.
 *
 * Scoping: a run is "active" only while ./.rtfm-trace/CURRENT exists. STEP 0 of
 * each SKILL.md writes it (the run's <slug>); the final STEP removes it. Outside
 * a run this hook is a quick no-op, so it's safe to leave registered.
 *
 * Contract (PostToolUse): receives the event JSON on stdin (.cwd, .session_id,
 * .tool_name, .tool_input). It is non-blocking — it never affects the tool
 * result. It writes ONLY to the trace file, emits nothing on stdout, and always
 * exits 0. Works in interactive and headless runs alike.
 *
 * No lock: each entry is a single small line (long fields truncated to 500
 * characters), so the append stays under PIPE_BUF and is atomic on local
 * filesystems even when the agent fires tool calls in parallel.
 */

const fs = require('fs');
const path = require('path');

function truncate(value) {
    if (value === undefined || value === null) return null;
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return [...text].slice(0, 500).join('');
}

function orNull(value) {
    return value === undefined || value === null || value === false ? null : value;
}

function record(payload, now = new Date()) {
    const input = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {};
    return {
        ts: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
        session: payload.session_id ?? null,
        tool: payload.tool_name ?? null,
        file: orNull(input.file_path),
        pattern: orNull(input.pattern),
        path: orNull(input.path),
        glob: orNull(input.glob),
        command: truncate(input.command),
    };
}

function main(stdin) {
    let payload;
    try { payload = JSON.parse(stdin); } catch { return; }
    if (!payload || typeof payload !== 'object') return;
    const cwd = orNull(payload.cwd);
    if (!cwd) return;

    const marker = path.join(String(cwd), '.rtfm-trace', 'CURRENT');
    let slug;
    try { slug = fs.readFileSync(marker, 'utf8').split('\n')[0].split('\t')[0]; }
    catch { return; } // not inside a skill run -> no-op
    const out = path.join(String(cwd), '.rtfm-trace', `${slug || 'run'}.ndjson`);

    try { fs.appendFileSync(out, JSON.stringify(record(payload)) + '\n'); }
    catch { /* never affect the tool call */ }
}

if (require.main === module) {
    const chunks = [];
    process.stdin.on('data', chunk => chunks.push(chunk));
    process.stdin.on('end', () => {
        try { main(Buffer.concat(chunks).toString('utf8')); } catch { /* always exit 0 */ }
        process.exitCode = 0;
    });
    process.stdin.on('error', () => { process.exitCode = 0; });
}

module.exports = { record };
