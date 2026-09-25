#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { computeSignals } = require('./emit_walkthrough_signals.js');

const SCRIPT = path.join(__dirname, 'emit_walkthrough_signals.js');

function articleV2(overrides = {}) {
    return {
        schema_version: 2,
        title: 'How to invite a teammate',
        article_type: 'how-to',
        blocks: [
            { id: 'intro', type: 'prose', presentation: 'lead', content: 'Invite teammates.' },
            { id: 'open-settings', type: 'section', presentation: 'numbered', title: 'Open settings', content: 'Click **Settings**.', has_image: true },
            { id: 'enter-email', type: 'section', presentation: 'numbered', title: 'Enter the email', content: 'Type the address.', has_image: true },
            { id: 'confirm', type: 'section', presentation: 'numbered', title: 'Confirm', content: 'Click **Send**.', has_image: false },
        ],
        ...overrides,
    };
}

function viewSourcesBlocks(overrides = {}) {
    return {
        framework: 'rails',
        action_coverage: [
            { article_block_id: 'open-settings', screenshot_block_id: 'open-settings', kind: 'click', target: 'Settings', state: 'action-ready' },
            { article_block_id: 'enter-email', screenshot_block_id: 'enter-email', kind: 'type', target: 'Email', state: 'action-ready' },
        ],
        blocks: [
            { block_id: 'open-settings', primary_view: 'app/views/settings/index.html.erb' },
            { block_id: 'enter-email', primary_view: 'app/views/settings/invites.html.erb' },
        ],
        ...overrides,
    };
}

function articleLegacy() {
    return {
        title: 'How to invite a teammate',
        article_type: 'how-to',
        introduction: 'Invite teammates.',
        prerequisites: [],
        steps: [
            { title: 'Open settings', content: 'Click **Settings**.', has_image: true },
            { title: 'Enter the email', content: 'Type the address.', has_image: false },
        ],
        tips: [],
        summary: 'Done.',
    };
}

function viewSourcesSteps() {
    return {
        framework: 'rails',
        action_coverage: [
            { article_step_index: 0, screenshot_step_index: 0, kind: 'click', target: 'Settings', state: 'action-ready' },
        ],
        steps: [
            { index: 0, primary_view: 'app/views/settings/index.html.erb' },
            { index: 1, primary_view: 'app/views/settings/index.html.erb' },
        ],
    };
}

function run() {
    // Block-keyed schema-v2 artifacts.
    let signals = computeSignals(articleV2(), viewSourcesBlocks(), 'web');
    assert.deepStrictEqual(signals, {
        schema_version: 1,
        article_type: 'how-to',
        sections_total: 3,
        sections_with_images: 2,
        distinct_surfaces: 2,
        action_count: 2,
        action_kinds: ['click', 'type'],
        typed_input: true,
        unsupported_action_kinds: [],
        external_surfaces: 0,
        app_type: 'web',
    });

    // Legacy index-keyed artifacts (article_blocks.js synthesizes sections).
    signals = computeSignals(articleLegacy(), viewSourcesSteps(), 'web');
    assert.strictEqual(signals.sections_total, 2);
    assert.strictEqual(signals.sections_with_images, 1);
    assert.strictEqual(signals.distinct_surfaces, 1);
    assert.strictEqual(signals.action_count, 1);
    assert.strictEqual(signals.typed_input, false);

    // External-surface entries count separately and never contribute a surface.
    signals = computeSignals(articleV2(), viewSourcesBlocks({
        blocks: [
            { block_id: 'open-settings', primary_view: 'app/views/settings/index.html.erb' },
            { block_id: 'enter-email', url_or_route: 'external:confirmation-email',
                external_surface: { asset_id: 'confirmation-email', surface: 'email' } },
        ],
    }), 'web');
    assert.strictEqual(signals.external_surfaces, 1);
    assert.strictEqual(signals.distinct_surfaces, 1);

    // Recorder-unsupported kinds are surfaced; the supported set is not.
    signals = computeSignals(articleV2(), viewSourcesBlocks({
        action_coverage: [
            { article_block_id: 'open-settings', kind: 'drag', target: 'Card', state: 'action-ready' },
            { article_block_id: 'enter-email', kind: 'upload', target: 'Attach', state: 'action-ready' },
            { article_block_id: 'confirm', kind: 'toggle', target: 'Notify', state: 'action-ready' },
        ],
    }), 'mobile');
    assert.deepStrictEqual(signals.unsupported_action_kinds, ['drag', 'upload']);
    assert.strictEqual(signals.app_type, 'mobile');

    // Tolerates absent action_coverage / malformed entries (pre-v1.41 artifacts).
    signals = computeSignals(articleLegacy(), { framework: 'rails', steps: [null, { index: 1 }] }, 'web');
    assert.strictEqual(signals.action_count, 0);
    assert.deepStrictEqual(signals.action_kinds, []);
    assert.strictEqual(signals.distinct_surfaces, 0);

    // CLI: writes the sidecar for a valid artifact dir.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rtfm-walkthrough-signals-'));
    try {
        fs.writeFileSync(path.join(root, 'article.json'), JSON.stringify(articleV2()));
        fs.writeFileSync(path.join(root, 'view_sources.json'), JSON.stringify(viewSourcesBlocks()));
        let cli = spawnSync(process.execPath, [SCRIPT, root], { encoding: 'utf8' });
        assert.strictEqual(cli.status, 0, cli.stderr);
        const written = JSON.parse(fs.readFileSync(path.join(root, 'walkthrough_signals.json'), 'utf8'));
        assert.strictEqual(written.schema_version, 1);
        assert.strictEqual(written.distinct_surfaces, 2);

        // CLI: missing view_sources.json is a warning + exit 0, no file written.
        const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'rtfm-walkthrough-signals-'));
        try {
            fs.writeFileSync(path.join(empty, 'article.json'), JSON.stringify(articleV2()));
            cli = spawnSync(process.execPath, [SCRIPT, empty], { encoding: 'utf8' });
            assert.strictEqual(cli.status, 0, cli.stderr);
            assert.match(cli.stderr, /walkthrough signals skipped/);
            assert.strictEqual(fs.existsSync(path.join(empty, 'walkthrough_signals.json')), false);
        } finally {
            fs.rmSync(empty, { recursive: true, force: true });
        }

        // CLI: no argument is a usage error.
        cli = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
        assert.strictEqual(cli.status, 2);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }

    console.log('walkthrough signals tests passed');
}

run();
