#!/usr/bin/env node
'use strict';

// Distills walkthrough-worthiness signals from a generated article's artifacts
// (article.json + view_sources.json) into $OUT/walkthrough_signals.json.
// Consumed later by the recommend-walkthroughs skill via the RTFM context file.
// Informational, never a lint: any missing or unparsable input logs a warning
// and exits 0 without writing, so the article pipeline can never fail here.

const fs = require('fs');
const path = require('path');
const { blocks, articleType } = require('./article_blocks.js');

// Interaction kinds record_walkthrough.js cannot perform (supported: click,
// type-into, select, check, swipe, hover, scroll-to).
const UNSUPPORTED_KINDS = new Set(['drag', 'upload', 'keyboard']);

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function atomicWrite(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
    fs.renameSync(temporary, file);
}

function detectAppType(projectRoot) {
    for (const dir of ['.rtfm', '.rtfm-branding']) {
        try {
            const map = readJson(path.join(projectRoot, dir, 'project_map.json'));
            if (map && typeof map.app_type === 'string') return map.app_type;
        } catch (error) { /* missing or unparsable map — fall through */ }
    }
    return 'web';
}

function computeSignals(article, viewSources, appType) {
    const sections = blocks(article).filter(block => block && block.type === 'section');

    // view_sources step containers: block-keyed `blocks[]` (schema v2 articles)
    // or index-keyed `steps[]` (legacy). External-surface entries carry
    // `external_surface` and no primary_view.
    const entries = Array.isArray(viewSources && viewSources.blocks) ? viewSources.blocks
        : Array.isArray(viewSources && viewSources.steps) ? viewSources.steps : [];
    const surfaces = new Set();
    let externalSurfaces = 0;
    for (const entry of entries) {
        if (!entry || typeof entry !== 'object') continue;
        if (entry.external_surface) externalSurfaces += 1;
        else if (typeof entry.primary_view === 'string' && entry.primary_view.trim()) {
            surfaces.add(entry.primary_view.trim());
        }
    }

    const coverage = Array.isArray(viewSources && viewSources.action_coverage)
        ? viewSources.action_coverage.filter(item => item && typeof item === 'object') : [];
    const kinds = [...new Set(coverage.map(item => item.kind).filter(kind => typeof kind === 'string' && kind))].sort();

    return {
        schema_version: 1,
        article_type: articleType(article),
        sections_total: sections.length,
        sections_with_images: sections.filter(section => section.has_image === true).length,
        distinct_surfaces: surfaces.size,
        action_count: coverage.length,
        action_kinds: kinds,
        typed_input: kinds.includes('type'),
        unsupported_action_kinds: kinds.filter(kind => UNSUPPORTED_KINDS.has(kind)),
        external_surfaces: externalSurfaces,
        app_type: appType,
    };
}

function main() {
    const outDir = process.argv[2];
    if (!outDir) {
        console.error('usage: emit_walkthrough_signals.js OUT_DIR');
        process.exitCode = 2;
        return;
    }
    let article;
    let viewSources;
    try {
        article = readJson(path.join(outDir, 'article.json'));
        viewSources = readJson(path.join(outDir, 'view_sources.json'));
    } catch (error) {
        console.error(`walkthrough signals skipped: ${error.message}`);
        return;
    }
    const signals = computeSignals(article, viewSources, detectAppType(process.cwd()));
    atomicWrite(path.join(outDir, 'walkthrough_signals.json'), signals);
    console.log(`walkthrough signals: ${signals.distinct_surfaces} surfaces, `
        + `${signals.action_count} actions (${signals.action_kinds.join(', ') || 'none'})`);
}

module.exports = { UNSUPPORTED_KINDS, computeSignals, detectAppType };

if (require.main === module) main();
