#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const lint = path.join(__dirname, 'lint_mockup_fidelity.js');
const renderAll = path.join(__dirname, 'render_all.js');

function write(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

function fixture(mutator = () => {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rtfm-lint-'));
    const out = path.join(root, 'out');
    const source = 'views/runtime.html';
    const projectMap = {
        schema_version: 5,
        app_type: 'web',
        app_shell: null,
        layouts: [{
            name: 'runtime', path: source, chrome: [], root_classes: { html: [], body: [] },
            runtime_chrome: {
                app: 'Editor', source_kind: 'repo', source_files: [source],
                regions: [
                    { id: 'toolbar', region: 'toolbar', placement: 'top', required: true,
                        items: [{ id: 'actions', kind: 'control-group', description: 'Editor actions', required_strings: ['Save'] }],
                        appearance: 'Light compact command bar', ui_strings: ['Save'],
                        required_strings: ['Save'], source_files: [source] },
                    { id: 'canvas', region: 'canvas', placement: 'canvas', required: true,
                        items: [{ id: 'document', kind: 'content-section', description: 'Populated document', required_strings: ['Document'] }],
                        appearance: 'Large white document canvas', content_mode: 'populated',
                        media_expectation: 'none', representative_assets: [], max_selected_outlines: 1,
                        ui_strings: ['Document'],
                        required_strings: ['Document'], source_files: [source] },
                ],
                states: [{ id: 'editing', name: 'editing', kind: 'action', screenshot_required: true,
                    topic_tags: ['edit'], instructional_priority: 'primary-action',
                    context_label: 'Document', canvas_presentation: 'Populated full editing canvas.',
                    entered_by: 'Open', shows: 'Document open', required_regions: [],
                    visible_regions: ['toolbar', 'canvas'], required_strings: ['Document'], source_files: [source] }],
            },
        }],
    };
    const viewSources = {
        framework: 'test',
        runtime_state_selection: { layout: 'runtime', selected: ['editing'], dropped: [] },
        steps: [{ index: 0, url_or_route: '/edit', controller_action: source,
            primary_view: source, layout: 'runtime', partials_expanded: [source],
            runtime_state_id: 'editing', runtime_source_files: [source],
            depicted_state: 'Document open for editing', default_user_assumptions: [],
            verbatim_evidence: ['Save', 'Document', 'Editor'] }],
    };
    let html = '<!doctype html><html><head><style>body{color:#111}</style></head>' +
        '<body data-rtfm-state="editing"><header data-rtfm-region="toolbar" data-rtfm-placement="top"><span data-rtfm-item="toolbar:actions">Save Editor</span></header>' +
        '<main data-rtfm-region="canvas" data-rtfm-placement="canvas"><article data-rtfm-item="canvas:document">Document</article></main></body></html>';
    const state = { projectMap, viewSources, generatedManifest: null, article: null, skipHtml: false, blockId: null, extraFiles: {},
        get html() { return html; }, set html(v) { html = v; } };
    mutator(state);
    write(path.join(root, '.rtfm', 'project_map.json'), projectMap);
    write(path.join(root, source), 'Save Document Editor');
    for (const [rel, text] of Object.entries(state.extraFiles || {})) write(path.join(root, rel), text);
    write(path.join(out, 'view_sources.json'), viewSources);
    if (state.article) write(path.join(out, 'article.json'), state.article);
    if (state.generatedManifest) write(path.join(out, 'generated_images.json'), state.generatedManifest);
    if (!state.skipHtml) write(path.join(out, state.blockId ? `block_${state.blockId}.html` : 'step_0.html'), html);
    write(path.join(out, 'branding.css'), 'body{color:#111}');
    const env = { ...process.env, ...(state.env || {}) };
    if (!state.env || !('RTFM_MAX_IMAGES' in state.env)) delete env.RTFM_MAX_IMAGES;
    const proc = spawnSync(process.execPath, [lint, out, root], { encoding: 'utf8', env });
    const report = JSON.parse(fs.readFileSync(path.join(out, 'lint_report.json'), 'utf8'));
    fs.rmSync(root, { recursive: true, force: true });
    return { status: proc.status, report };
}

let result = fixture();
assert.strictEqual(result.status, 0, JSON.stringify(result.report));

result = fixture(s => {
    s.blockId = 'edit-document';
    s.article = { schema_version: 2, title: 'How to edit', article_type: 'how-to', blocks: [
        { id: 'edit-document', type: 'section', presentation: 'numbered', title: 'Edit the document', content: 'Review the document.', has_image: true },
    ] };
    s.viewSources.blocks = [{ ...s.viewSources.steps[0], block_id: 'edit-document' }];
    delete s.viewSources.steps;
});
assert.strictEqual(result.status, 0, JSON.stringify(result.report));
assert.strictEqual(result.report.blocks[0].block_id, 'edit-document');

// view_sources lists only illustrated sections; blocks are numbered by their
// section's position in article.json, so a screenshot on a later section (and
// coverage from a text-only section) lines up with the article's steps.
const laterSection = s => {
    s.blockId = 'edit-document';
    s.article = { schema_version: 2, title: 'How to edit', article_type: 'how-to', blocks: [
        { id: 'intro', type: 'prose', presentation: 'lead', content: 'Edit a document in the editor.' },
        { id: 'before-you-start', type: 'section', presentation: 'numbered', title: 'Before you start', content: 'Documents open in the editor.', has_image: false },
        { id: 'edit-document', type: 'section', presentation: 'numbered', title: 'Edit the document', content: 'Review the document.', has_image: true },
        { id: 'save-changes', type: 'section', presentation: 'numbered', title: 'Save your changes', content: 'Select **Save**.', has_image: false },
    ] };
    s.viewSources.blocks = [{ ...s.viewSources.steps[0], block_id: 'edit-document' }];
    delete s.viewSources.steps;
    s.viewSources.action_coverage = [{ article_block_id: 'save-changes', screenshot_block_id: 'edit-document',
        kind: 'click', target: 'Save', state: 'action-ready' }];
    s.html = s.html.replace('data-rtfm-item="toolbar:actions"',
        'data-rtfm-item="toolbar:actions" data-rtfm-action-target="save-changes"');
};
result = fixture(laterSection);
assert.strictEqual(result.status, 0, JSON.stringify(result.report));
assert.strictEqual(result.report.blocks[0].block_id, 'edit-document');

result = fixture(s => { laterSection(s); s.viewSources.blocks[0].block_id = 'edit-doc'; s.blockId = 'edit-doc'; });
assert.strictEqual(result.status, 1);
assert(result.report.global_errors.some(e => e.includes("block 'edit-doc' names no section in article.json")),
    JSON.stringify(result.report.global_errors));

result = fixture(s => { s.html = s.html.replace(' data-rtfm-region="canvas"', ''); });
assert.strictEqual(result.status, 1);
assert(result.report.steps[0].errors.some(e => e.includes("runtime region 'canvas'")));

result = fixture(s => {
    s.projectMap.layouts[0].runtime_chrome.regions.push({
        id: 'inspector', region: 'inspector', placement: 'right', required: false,
        items: [{ id: 'settings', kind: 'settings-list', description: 'Settings', required_strings: [] }],
        appearance: 'Right settings inspector', ui_strings: [],
        required_strings: [], source_files: [s.projectMap.layouts[0].path],
    });
    s.html = s.html.replace('</body>', '<aside data-rtfm-region="inspector" data-rtfm-placement="right">Inspector</aside></body>');
});
assert.strictEqual(result.status, 1);
assert(result.report.steps[0].errors.some(e => e.includes("is not visible in state 'editing'")));

result = fixture(s => {
    const canvas = s.projectMap.layouts[0].runtime_chrome.regions[1];
    canvas.media_expectation = 'required';
    canvas.representative_assets = [s.projectMap.layouts[0].path];
});
assert.strictEqual(result.status, 1);
assert(result.report.steps[0].errors.some(e => e.includes('runtime canvas asset')));

result = fixture(s => { s.viewSources.steps[0].runtime_state_id = 'invented'; });
assert.strictEqual(result.status, 1);
assert(result.report.steps[0].errors.some(e => e.includes('valid runtime_state_id')));

result = fixture(s => { s.viewSources.steps[0].runtime_source_files = ['views/adjacent.html']; });
assert.strictEqual(result.status, 1);
assert(result.report.steps[0].errors.some(e => e.includes('runtime_source_files must exactly match')));

result = fixture(s => {
    s.generatedManifest = { version: 1, max_assets: 5, count: 1, model: 'gpt-image-2', assets: {
        'participant-alex': { status: 'generated', path: 'generated-assets/participant-alex.png',
            kind: 'video-frame', reason: 'A live camera feed is required and no repo image exists',
            used_in_steps: [0] },
    } };
    s.html = s.html.replace('</article>', '<img src="{{generated:participant-alex}}" data-rtfm-generated-asset="participant-alex" alt="Fictional participant"></article>');
});
assert.strictEqual(result.status, 0, JSON.stringify(result.report));

result = fixture(s => {
    s.projectMap.layouts = [];
    delete s.viewSources.runtime_state_selection;
    s.viewSources.steps = [];
    s.viewSources.action_coverage = [];
    s.viewSources.generation_omissions = [{
        asset_id: 'confirm-email', article_step_indexes: [0],
        reason: 'Image generation failed; the external step is text-only.',
    }];
    s.article = { title: 'How to confirm', article_type: 'how-to',
        introduction: 'Confirm your account.', prerequisites: [],
        steps: [{ title: 'Confirm', content: 'Select **Confirm email**.', has_image: false }],
        tips: [], summary: 'The account is confirmed.' };
    s.generatedManifest = { version: 1, max_assets: 5, requested_count: 1,
        count: 0, failure_count: 1, model: 'gpt-image-2', assets: {}, failures: {
            'confirm-email': { status: 'failed', kind: 'external-surface',
                reason: 'External email required', used_in_steps: [0] },
        } };
    s.skipHtml = true;
});
assert.strictEqual(result.status, 0, JSON.stringify(result.report));

result = fixture(s => {
    s.projectMap.layouts = [];
    delete s.viewSources.runtime_state_selection;
    s.viewSources.steps = [];
    s.viewSources.action_coverage = [];
    s.viewSources.generation_omissions = [{
        asset_id: 'confirm-email', article_step_indexes: [0], reason: 'Missing image.',
    }];
    s.article = { title: 'How to confirm', article_type: 'how-to',
        introduction: 'Confirm your account.', prerequisites: [],
        steps: [{ title: 'Confirm', content: 'Select **Confirm email**.', has_image: false }],
        tips: [], summary: 'The account is confirmed.' };
    s.skipHtml = true;
});
assert.strictEqual(result.status, 1);
assert(result.report.global_errors.some(e => e.includes('must match a failed external-surface request')));

result = fixture(s => {
    const step = s.viewSources.steps[0];
    delete step.primary_view;
    delete step.layout;
    delete step.partials_expanded;
    delete step.runtime_state_id;
    delete step.runtime_source_files;
    step.url_or_route = 'external:confirmation-email';
    step.verbatim_evidence = [];
    step.external_surface = {
        asset_id: 'confirm-email',
        surface: 'confirmation-email',
        source_basis: 'user-description',
        source_files: [],
        required_text: ['Confirm your email address', 'Confirm email'],
    };
    s.generatedManifest = { version: 1, max_assets: 5, count: 1, model: 'gpt-image-2', assets: {
        'confirm-email': { status: 'generated', path: 'generated-assets/confirm-email.png',
            kind: 'external-surface', surface: 'confirmation-email',
            source_basis: 'user-description', source_files: [],
            required_text: ['Confirm your email address', 'Confirm email'],
            text_fidelity: { enforcement: 'prompt-constrained', required_text_count: 2 },
            reason: 'The email is outside the product and no renderable template exists',
            used_in_steps: [0] },
    } };
    s.html = '<!doctype html><html><head></head><body data-rtfm-surface="external">' +
        '<img style="position:fixed;inset:0;width:100vw;height:100vh" ' +
        'src="{{generated:confirm-email}}" data-rtfm-generated-asset="confirm-email" ' +
        'data-rtfm-external-surface="confirmation-email" alt="Confirmation email"></body></html>';
});
assert.strictEqual(result.status, 0, JSON.stringify(result.report));

result = fixture(s => {
    const step = s.viewSources.steps[0];
    step.external_surface = { asset_id: 'confirm-email', surface: 'confirmation-email',
        source_basis: 'user-description', source_files: [], required_text: ['Wrong text'] };
    s.generatedManifest = { version: 1, max_assets: 5, count: 1, model: 'gpt-image-2', assets: {
        'confirm-email': { kind: 'external-surface', surface: 'confirmation-email',
            source_basis: 'user-description', source_files: [],
            required_text: ['Confirm email'],
            text_fidelity: { enforcement: 'prompt-constrained', required_text_count: 1 },
            reason: 'External email required', used_in_steps: [0] },
    } };
    s.html = s.html.replace('<body ', '<body data-rtfm-surface="external" ')
        .replace('</article>', '<img src="{{generated:confirm-email}}" data-rtfm-generated-asset="confirm-email" data-rtfm-external-surface="confirmation-email"></article>');
});
assert.strictEqual(result.status, 1);
assert(result.report.steps[0].errors.some(e => e.includes('does not exactly match')));
assert(result.report.steps[0].errors.some(e => e.includes('standalone external step')));

result = fixture(s => {
    s.generatedManifest = { version: 1, max_assets: 5, count: 1, assets: {
        'participant-alex': { kind: 'video-frame', reason: 'Camera content required', used_in_steps: [0] },
    } };
    s.html = s.html.replace('</article>', '<div src="{{generated:participant-alex}}" data-rtfm-generated-asset="participant-alex"></div></article>');
});
assert.strictEqual(result.status, 1);
assert(result.report.steps[0].errors.some(e => e.includes('must appear on an <img>')));

result = fixture(s => {
    s.generatedManifest = { version: 1, max_assets: 5, count: 1, assets: {
        'participant-alex': { kind: 'video-frame', reason: 'Camera content required', used_in_steps: [] },
    } };
    s.html = s.html.replace('</head>', '<style>body{background-image:url({{generated:participant-alex}})}</style></head>');
});
assert.strictEqual(result.status, 1);
assert(result.report.steps[0].errors.some(e => e.includes('CSS backgrounds')));

result = fixture(s => {
    s.generatedManifest = { version: 1, max_assets: 5, count: 1, assets: {
        'participant-alex': { kind: 'video-frame', reason: 'Camera content required', used_in_steps: [0] },
    } };
    s.html = s.html.replace('</article>', '<img style="position:fixed;inset:0" src="{{generated:participant-alex}}" data-rtfm-generated-asset="participant-alex"></article>');
});
assert.strictEqual(result.status, 1);
assert(result.report.steps[0].errors.some(e => e.includes('screen/region-sized')));

result = fixture(s => {
    const recipe = s.projectMap.layouts[0].runtime_chrome;
    recipe.source_kind = 'knowledge';
    recipe.source_files = [];
    recipe.regions.forEach(r => { r.source_files = []; });
    recipe.states.forEach(st => { st.source_files = []; });
    s.viewSources.steps[0].runtime_source_files = [];
});
assert.strictEqual(result.status, 0, JSON.stringify(result.report));

result = fixture(s => {
    s.article = { title: 'How to save', article_type: 'how-to', introduction: 'Save a document.',
        prerequisites: [], steps: [{ title: 'Save', content: 'Select **Save**.', has_image: true }],
        tips: [], summary: 'The document is saved.' };
    s.viewSources.action_coverage = [{ article_step_index: 0, screenshot_step_index: 0,
        kind: 'click', target: 'Save', state: 'action-ready' }];
    s.html = s.html.replace('data-rtfm-item="toolbar:actions"',
        'data-rtfm-item="toolbar:actions" data-rtfm-action-target="0"');
});
assert.strictEqual(result.status, 0, JSON.stringify(result.report));

result = fixture(s => {
    s.article = { title: 'How to type', article_type: 'how-to', introduction: 'Edit a document.',
        prerequisites: [], steps: [{ title: 'Enter text',
            content: 'In the editor, enter text in **Document**.', has_image: true }],
        tips: [], summary: 'The document contains the text.' };
    s.viewSources.action_coverage = [{ article_step_index: 0, screenshot_step_index: 0,
        kind: 'type', target: 'Document', state: 'action-ready' }];
    s.html = s.html.replace('data-rtfm-item="canvas:document"',
        'data-rtfm-item="canvas:document" data-rtfm-action-target="0"');
});
assert.strictEqual(result.status, 0, JSON.stringify(result.report));

result = fixture(s => {
    s.article = { title: 'How to save', article_type: 'how-to', introduction: 'Save a document.',
        prerequisites: [], steps: [{ title: 'Save', content: 'Select **Save**.', has_image: true }],
        tips: [], summary: 'The document is saved.' };
    s.viewSources.action_coverage = [{ article_step_index: 0, screenshot_step_index: 0,
        kind: 'click', target: 'Save', state: 'after' }];
    s.html = s.html.replace('data-rtfm-item="toolbar:actions"',
        'data-rtfm-item="toolbar:actions" data-rtfm-action-target="0"');
});
assert.strictEqual(result.status, 1);
assert(result.report.global_errors.some(e => e.includes('must use state "action-ready"')));

result = fixture(s => {
    s.article = { title: 'How to save', article_type: 'how-to', introduction: 'Save a document.',
        prerequisites: [], steps: [{ title: 'Save', content: 'Select **Save**.', has_image: true }],
        tips: [], summary: 'The document is saved.' };
});
assert.strictEqual(result.status, 1);
assert(result.report.global_errors.some(e => e.includes('requires an action_coverage array')));
assert(result.report.global_errors.some(e => e.includes('lack action-ready screenshot coverage')));

result = fixture(s => {
    s.article = { title: 'How to record', article_type: 'how-to', introduction: 'Record a meeting.',
        prerequisites: [], steps: [{ title: 'Start', content: 'Select **Start Recording**.', has_image: true }],
        tips: [], summary: 'Recording is active.' };
    s.viewSources.action_coverage = [{ article_step_index: 0, screenshot_step_index: 0,
        kind: 'click', target: 'Start Recording', state: 'action-ready' }];
    s.html = s.html.replace('data-rtfm-item="toolbar:actions"',
        'data-rtfm-item="toolbar:actions" data-rtfm-action-target="0"');
});
assert.strictEqual(result.status, 1);
assert(result.report.global_errors.some(e => e.includes('does not contain visible/accessibility text "Start Recording"')));
assert(result.report.global_errors.some(e => e.includes('must also appear exactly in verbatim_evidence')));

result = fixture(s => {
    s.article = { title: 'How to edit', article_type: 'how-to', introduction: 'Edit a document.',
        prerequisites: [], steps: [
            { title: 'Open', content: 'Open **Document**.', has_image: true },
            { title: 'Save', content: 'Select **Save**.', has_image: false },
        ], tips: [], summary: 'The document is saved.' };
    s.viewSources.action_coverage = [
        { article_step_index: 0, screenshot_step_index: 0, kind: 'click', target: 'Document', state: 'action-ready' },
        { article_step_index: 1, screenshot_step_index: 0, kind: 'click', target: 'Save', state: 'action-ready' },
    ];
    s.html = s.html
        .replace('data-rtfm-item="toolbar:actions"',
            'data-rtfm-item="toolbar:actions" data-rtfm-action-target="1"')
        .replace('data-rtfm-item="canvas:document"',
            'data-rtfm-item="canvas:document" data-rtfm-action-target="0"');
});
assert.strictEqual(result.status, 0, JSON.stringify(result.report));

result = fixture(s => {
    s.article = { title: 'How to record', article_type: 'how-to', introduction: 'Record a meeting.',
        prerequisites: [], steps: [
            { title: 'Open', content: 'Review Home.', has_image: false },
            { title: 'Start', content: 'Recording begins.', has_image: false },
            { title: 'Confirm', content: 'Confirm recording is active.', has_image: true },
        ], tips: [], summary: 'Recording is active.' };
    s.viewSources.steps[0].index = 3;
});
assert.strictEqual(result.status, 1);
assert(result.report.global_errors.some(e => e.includes('outside article.json\'s zero-based step range')));
assert(result.report.global_errors.some(e => e.includes('has no zero-based step 2')));

// ─── Deterministic metrics contract (additive; never affects errors/exit) ────
const METRIC_KEYS = ['shell_nav_labels', 'chrome_files_expanded', 'runtime_ui_strings', 'runtime_regions_rendered',
    'root_classes_html', 'layout_root_classes', 'verbatim_evidence_source', 'verbatim_evidence_html',
    'partials_present', 'body_class_tokens', 'styled_coverage', 'inline_classes_verified',
    'invented_colours', 'invented_copy', 'screen_closure'];
const ratio = (hits, total) => ({ hits, total, ratio: Math.round((hits / total) * 1000) / 1000 });
const allNull = () => Object.fromEntries(METRIC_KEYS.map(k => [k, null]));
function errorsTotal(report) {
    return report.global_errors.length + (report.steps || report.blocks).reduce((n, s) => n + s.errors.length, 0);
}
function warningsTotal(report) {
    return report.global_warnings.length + (report.steps || report.blocks).reduce((n, s) => n + s.warnings.length, 0);
}
function checkTotals(report) {
    assert.strictEqual(report.metrics.errors_total, errorsTotal(report));
    assert.strictEqual(report.metrics.warnings_total, warningsTotal(report));
}

// Baseline: key order is the contract; data-gated checks are null, never 0/0.
result = fixture();
assert.deepStrictEqual(Object.keys(result.report),
    ['framework', 'project_dir', 'global_errors', 'global_warnings', 'steps', 'all_passed', 'metrics']);
const baselineMetrics = result.report.steps[0].metrics;
assert.deepStrictEqual(Object.keys(baselineMetrics), METRIC_KEYS);
assert.deepStrictEqual(baselineMetrics, { ...allNull(),
    runtime_ui_strings: ratio(2, 2), runtime_regions_rendered: ratio(2, 2),
    verbatim_evidence_source: ratio(3, 3), verbatim_evidence_html: ratio(3, 3),
    partials_present: ratio(1, 1), invented_colours: { count: 0 }, invented_copy: { count: 0 } });
assert.deepStrictEqual(result.report.metrics, { action_coverage: null,
    runtime_states_selected: ratio(1, 1), undefined_css_vars: { count: 0 }, errors_total: 0, warnings_total: 0 });

// Block mode carries the same per-entry metrics.
result = fixture(s => {
    s.blockId = 'edit-document';
    s.article = { schema_version: 2, title: 'How to edit', article_type: 'how-to', blocks: [
        { id: 'edit-document', type: 'section', presentation: 'numbered', title: 'Edit the document', content: 'Review the document.', has_image: true },
    ] };
    s.viewSources.blocks = [{ ...s.viewSources.steps[0], block_id: 'edit-document' }];
    delete s.viewSources.steps;
});
assert.strictEqual(result.status, 0, JSON.stringify(result.report));
assert.deepStrictEqual(result.report.blocks[0].metrics, baselineMetrics);
assert(Object.keys(result.report).includes('blocks') && !Object.keys(result.report).includes('steps'));
checkTotals(result.report);

// Region removed: ratio drops, totals agree with the error lists.
result = fixture(s => { s.html = s.html.replace(' data-rtfm-region="canvas"', ''); });
assert.strictEqual(result.status, 1);
assert.deepStrictEqual(result.report.steps[0].metrics.runtime_regions_rendered, ratio(1, 2));
checkTotals(result.report);

// Evidence miss: both evidence ratios drop; still two errors.
result = fixture(s => { s.viewSources.steps[0].verbatim_evidence = ['Save', 'Document', 'Missing']; });
assert.strictEqual(result.status, 1);
assert.deepStrictEqual(result.report.steps[0].metrics.verbatim_evidence_source, ratio(2, 3));
assert.deepStrictEqual(result.report.steps[0].metrics.verbatim_evidence_html, ratio(2, 3));
assert.strictEqual(result.report.metrics.errors_total, 2);
checkTotals(result.report);

// Invented-copy cap: the message keeps its 10-entry cap, the metric counts all 12.
result = fixture(s => {
    const phrases = ['quantum lattice harmonics resonate', 'velvet orbital cadence shimmer',
        'granite pendulum whispers linger', 'crimson tidal vectors unfold', 'saffron glacier murmurs drift',
        'obsidian meadow currents ripple', 'cobalt thunder ribbons weave', 'amber canyon echoes tumble',
        'violet ember spirals ascend', 'silver monsoon lanterns flicker', 'copper zephyr mosaics glisten',
        'indigo harbor whistles scatter'];
    s.html = s.html.replace('</main>', '</main><p>' + phrases.map(p => p + '.').join(' ') + '</p>');
});
assert.strictEqual(result.status, 0, JSON.stringify(result.report));
assert(result.report.steps[0].warnings.some(w => w.startsWith('10 multi-word phrase(s)')), JSON.stringify(result.report.steps[0].warnings));
assert.deepStrictEqual(result.report.steps[0].metrics.invented_copy, { count: 12 });
checkTotals(result.report);

// Shell + chrome positive fixture: nav labels, chrome checklist, root classes.
const shellMutator = htmlClass => s => {
    const source = s.projectMap.layouts[0].path;
    s.projectMap.app_shell = { nav_items: [{ label: 'Dashboard' }, { label: 'Pages' }, { label: 'Settings' }],
        root_classes: { html: ['wp-toolbar'], body: [] } };
    delete s.projectMap.layouts[0].root_classes;
    s.projectMap.layouts[0].chrome = ['views/_header.html', 'views/_footer.html', 'sidebar', 'the top bar prose'];
    s.extraFiles = { 'views/_header.html': 'Header', 'views/_footer.html': 'Footer' };
    s.viewSources.steps[0].partials_expanded = [source, 'views/_header.html'];
    s.html = s.html.replace('<header data-rtfm-region="toolbar"', '<nav>Dashboard Pages Settings</nav><header data-rtfm-region="toolbar"');
    if (htmlClass) s.html = s.html.replace('<html>', `<html class="${htmlClass}">`);
};
result = fixture(shellMutator(null));
assert.strictEqual(result.status, 1);
let m = result.report.steps[0].metrics;
assert.deepStrictEqual(m.shell_nav_labels, ratio(3, 3));
assert.deepStrictEqual(m.chrome_files_expanded, ratio(1, 3));
assert.deepStrictEqual(m.root_classes_html, ratio(0, 1));
assert.deepStrictEqual(m.layout_root_classes, null);
assert.deepStrictEqual(m.partials_present, ratio(2, 2));
assert(result.report.steps[0].errors.some(e => e.includes('never expanded its recorded chrome file(s): views/_footer.html')));
assert(result.report.steps[0].errors.some(e => e.includes('missing class token(s) recorded in app_shell.root_classes: wp-toolbar')));
assert(result.report.steps[0].warnings.some(e => e.includes('records chrome sidebar')));
checkTotals(result.report);
result = fixture(shellMutator('wp-toolbar'));
m = result.report.steps[0].metrics;
assert.deepStrictEqual(m.root_classes_html, ratio(1, 1));
assert(!result.report.steps[0].errors.some(e => e.includes('app_shell.root_classes')));
checkTotals(result.report);

// Missing mockup: the step's metrics are all null (nothing measurable).
result = fixture(s => { s.skipHtml = true; });
assert.strictEqual(result.status, 1);
assert(result.report.steps[0].errors.some(e => e.includes('mockup file not found')));
assert.deepStrictEqual(result.report.steps[0].metrics, allNull());
checkTotals(result.report);

// Action coverage metric mirrors the coverage ledger.
const saveArticle = () => ({ title: 'How to save', article_type: 'how-to', introduction: 'Save a document.',
    prerequisites: [], steps: [{ title: 'Save', content: 'Select **Save**.', has_image: true }],
    tips: [], summary: 'The document is saved.' });
result = fixture(s => {
    s.article = saveArticle();
    s.viewSources.action_coverage = [{ article_step_index: 0, screenshot_step_index: 0,
        kind: 'click', target: 'Save', state: 'action-ready' }];
    s.html = s.html.replace('data-rtfm-item="toolbar:actions"', 'data-rtfm-item="toolbar:actions" data-rtfm-action-target="0"');
});
assert.strictEqual(result.status, 0, JSON.stringify(result.report));
assert.deepStrictEqual(result.report.metrics.action_coverage, ratio(1, 1));
result = fixture(s => { s.article = saveArticle(); });
assert.strictEqual(result.status, 1);
assert.deepStrictEqual(result.report.metrics.action_coverage, ratio(0, 1));
checkTotals(result.report);


function renderFixture(leftIsWrong) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rtfm-render-'));
    const leftStyle = leftIsWrong ? 'position:absolute;left:850px;top:60px' : 'position:absolute;left:0;top:60px';
    write(path.join(root, 'step_0.html'), '<!doctype html><html><head><style>' +
        'html,body{margin:0;width:1200px;height:800px}.toolbar{height:60px;width:1200px}' +
        '.canvas{position:absolute;left:240px;top:60px;width:960px;height:740px}.side{width:240px;height:740px}' +
        '</style></head><body data-viewport="wide" data-rtfm-state="editing">' +
        '<header class="toolbar" data-rtfm-region="toolbar" data-rtfm-placement="top">Toolbar</header>' +
        `<aside class="side" style="${leftStyle}" data-rtfm-region="sidebar" data-rtfm-placement="left">Sidebar</aside>` +
        '<main class="canvas" data-rtfm-region="canvas" data-rtfm-placement="canvas">Canvas</main>' +
        '</body></html>');
    const proc = spawnSync(process.execPath, [renderAll, root], {
        encoding: 'utf8', env: { ...process.env, RTFM_WATERMARK: 'off' }, timeout: 30000,
    });
    const timingPath = path.join(root, 'render_timing.json');
    if (!fs.existsSync(timingPath)) {
        const diagnostic = `renderer produced no timing report (status ${proc.status})\n${proc.stdout}${proc.stderr}`;
        fs.rmSync(root, { recursive: true, force: true });
        throw new Error(diagnostic);
    }
    const timing = JSON.parse(fs.readFileSync(timingPath, 'utf8'));
    fs.rmSync(root, { recursive: true, force: true });
    return { status: proc.status, timing, stdout: proc.stdout, stderr: proc.stderr };
}

let rendered = renderFixture(false);
assert.strictEqual(rendered.status, 0, rendered.stdout + rendered.stderr);
assert.strictEqual(rendered.timing.all_passed, true);

rendered = renderFixture(true);
assert.strictEqual(rendered.status, 1);
assert.strictEqual(rendered.timing.all_passed, false);
assert(rendered.timing.steps[0].geometry_errors.some(e => e.includes('not anchored on the left')));

// ── 6b. Screen closure (warn-only): the primary view's unconditional includes and
//        inline sections must leave a trace; overlays and guarded pieces are exempt.
const closureView = [
    '<%= render partial: "shared/toolbar" %>',
    '<h3>Document details</h3><label>Document title</label>',
    '<h3>Sharing options</h3><label>Allow comments</label>',
    '<% if @admin %><h3>Danger zone</h3><button>Delete everything</button><% end %>',
    '<%= render partial: "modals/share_modal" %>',
].join('\n');
const closureFiles = {
    'views/closure.html.erb': closureView,
    'views/shared/_toolbar.html.erb': '<button>Save changes</button>',
    'views/modals/_share_modal.html.erb': '<div class="modal"><h5>Share with people</h5></div>',
};
const closureStep = s => {
    s.viewSources.steps[0].primary_view = 'views/closure.html.erb';
    s.viewSources.steps[0].partials_expanded = ['views/runtime.html', 'views/shared/_toolbar.html.erb', 'views/modals/_share_modal.html.erb'];
    s.viewSources.steps[0].verbatim_evidence = ['Document details', 'Document title'];
    s.extraFiles = closureFiles;
};
result = fixture(s => {
    closureStep(s);
    s.html = s.html.replace('<article data-rtfm-item="canvas:document">Document</article>',
        '<article data-rtfm-item="canvas:document">Document <button>Save changes</button><h3>Document details</h3>Document title <h3>Sharing options</h3>Allow comments</article>');
});
assert.strictEqual(result.status, 0, JSON.stringify(result.report));
assert(!result.report.steps[0].warnings.some(w => w.includes('renders unconditionally')), 'complete screen draws no closure warning');
assert.deepStrictEqual(result.report.steps[0].metrics.screen_closure, ratio(3, 3), 'toolbar + 2 sections; the guarded section and the modal are exempt');

result = fixture(s => {
    closureStep(s);
    s.html = s.html.replace('<article data-rtfm-item="canvas:document">Document</article>',
        '<article data-rtfm-item="canvas:document">Document <h3>Document details</h3>Document title</article>');
});
assert.strictEqual(result.status, 0, 'screen closure is warn-only');
const closureWarn = result.report.steps[0].warnings.find(w => w.includes('renders unconditionally'));
assert(closureWarn, JSON.stringify(result.report.steps[0].warnings));
assert(closureWarn.includes('shared/toolbar') && closureWarn.includes('Sharing options'), closureWarn);
assert(!closureWarn.includes('Danger zone') && !closureWarn.includes('share_modal'), 'guarded and overlay pieces never warn');
assert.deepStrictEqual(result.report.steps[0].metrics.screen_closure, ratio(1, 3));

result = fixture(s => {                       // a modal step: primary_view is the overlay → exempt
    closureStep(s);
    s.viewSources.steps[0].primary_view = 'views/modals/_share_modal.html.erb';
    s.viewSources.steps[0].verbatim_evidence = ['Share with people'];
    s.html = s.html.replace('Document</article>', 'Document Share with people</article>');
});
assert.strictEqual(result.report.steps[0].metrics.screen_closure, null);

// Code in step content is never a UI action: a fenced command whose first word
// is an action verb must not demand action coverage, while the same words as
// prose still do.
result = fixture(s => {
    s.article = { title: 'How to start', article_type: 'how-to', introduction: 'Start the app.',
        prerequisites: [], steps: [{ title: 'Start', content: 'Review the output below.\n```\nstart app --port 3000\n```\nThen check `start --help`.', has_image: true }],
        tips: [], summary: 'The app is running.' };
});
assert.strictEqual(result.status, 0, JSON.stringify(result.report));
result = fixture(s => {
    s.article = { title: 'How to start', article_type: 'how-to', introduction: 'Start the app.',
        prerequisites: [], steps: [{ title: 'Start', content: 'Review the output below. Start app.', has_image: true }],
        tips: [], summary: 'The app is running.' };
});
assert.strictEqual(result.status, 1);
assert(result.report.global_errors.some(e => /action/i.test(e)), JSON.stringify(result.report.global_errors));

console.log('lint_mockup_fidelity schema-v5 tests passed');

// A Rails-generated submit label is checked against the real form/model binding.
function generatedSubmitFixture(wrongLabel = false) {
    return fixture(s => {
        const label = wrongLabel ? 'Create invented label' : 'Create API key';
        s.extraFiles = {
            'form.erb':'<%= form_with(model: @record) do |f| %><%= f.submit %><% end %>',
            'controller.rb':'@record = APIKey.new',
            'model.rb':'class APIKey < ActiveRecord::Base\nend',
            'config/initializers/inflections.rb':"ActiveSupport::Inflector.inflections(:en) do |i|\n i.acronym 'API'\nend",
        };
        s.viewSources.steps[0].verbatim_evidence.push({string:label,found_in:'form.erb',generated:{kind:'rails_submit',locale:'en',action:'create',binding:'@record',binding_source:'controller.rb',model_source:'model.rb'}});
        s.html = s.html.replace('</main>',`<input type="submit" value="${label}" data-rtfm-action-target="0"></main>`);
        s.viewSources.action_coverage = [{article_step_index:0,screenshot_step_index:0,kind:'click',state:'action-ready',target:label}];
    });
}
result = generatedSubmitFixture();
assert.equal(result.status,0,JSON.stringify(result.report));
result = generatedSubmitFixture(true);
assert.equal(result.status,1);
assert(result.report.steps[0].errors.some(e => e.includes('contradicts source')));

// Screenshot limit (max_images / RTFM_MAX_IMAGES): hard, and once reached the
// remaining actions are text-only warnings rather than coverage errors.
function limitFixture(limit, stepImages) {
    return fixture(st => {
        st.env = { RTFM_MAX_IMAGES: String(limit) };
        st.article = { title: 'How to edit', article_type: 'how-to', introduction: 'Edit a document.',
            prerequisites: [], steps: [
                { title: 'Open', content: 'Open **Document**.', has_image: true },
                { title: 'Save', content: 'Select **Save**.', has_image: stepImages > 1 },
            ], tips: [], summary: 'The document is saved.' };
        st.viewSources.action_coverage = [
            { article_step_index: 0, screenshot_step_index: 0, kind: 'click', target: 'Document', state: 'action-ready' },
        ];
        st.html = st.html.replace('data-rtfm-item="canvas:document"',
            'data-rtfm-item="canvas:document" data-rtfm-action-target="0"');
    });
}
result = limitFixture(1, 1);
assert.strictEqual(result.status, 0, JSON.stringify(result.report));
assert(result.report.global_warnings.some(w => w.includes('step(s) 1 are text-only: the 1-screenshot limit is reached')));
result = limitFixture(2, 1);
assert.strictEqual(result.status, 1);
assert(result.report.global_errors.some(e => e.includes('lack action-ready screenshot coverage: 1') && e.includes('1 of 2 screenshot(s) remain')));
result = limitFixture(1, 2);
assert.strictEqual(result.status, 1);
assert(result.report.global_errors.some(e => e.includes('article has 2 screenshots; the limit is 1')));
console.log('screenshot limit tests passed');
