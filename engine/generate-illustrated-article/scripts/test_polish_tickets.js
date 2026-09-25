#!/usr/bin/env node
/**
 * polish_tickets.js tests — fixture builder + one probe per question generator,
 * the thresholds at their boundaries, the env gate, the block cap, the report,
 * and the degrade-to-fewer-questions posture on missing inputs.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'polish_tickets.js');
const { buildTickets, buildReport } = require(SCRIPT);

function write(file, contents) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents, null, 2));
}
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

/** Build a web project + article dir; `mutate(ctx)` adjusts the pieces before they are written. */
function fixture(mutate) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rtfm-polish-'));
    const out = path.join(root, 'output', 'articles', 'how-to-manage-event-types');
    const ctx = {
        root, out,
        projectMap: {
            schema_version: 5, app_type: 'web', framework: 'nextjs',
            app_shell: {
                type: 'left-sidebar', layout: 'main',
                nav_items: [
                    { label: 'Dashboard', href: '/' }, { label: 'Bookings', href: '/bookings' },
                    { label: 'Availability', href: '/availability' }, { label: 'Apps', href: '/apps' },
                    { label: 'Settings', href: '/settings', children: [{ label: 'Profile', href: '/settings/profile' }] },
                ],
                footer_items: [{ label: 'Help centre', href: '/help' }],
                account_area: 'avatar + name at the top of the sidebar',
                top_bar: { items_left: ['Logo (links home)'], items_right: ['Notifications'] },
            },
            layouts: [
                { name: 'main', path: 'src/layouts/main.tsx', chrome: ['src/shell/Sidebar.tsx', 'src/shell/Topbar.tsx'], area: 'main authenticated shell' },
                { name: 'editor', path: 'src/layouts/editor.tsx', chrome: [], area: 'fullscreen editor',
                  runtime_chrome: { regions: [{ name: 'toolbar', ui_strings: ['Publish', 'Save draft'] }], ui_strings: ['Publish', 'Save draft', 'Add title'] } },
            ],
        },
        sources: {
            'src/pages/List.tsx': [
                'import { useState } from "react";',
                'import RowMenu from "./RowMenu";',
                'import { Button } from "@ui/button";',
                'import { IconPlus } from "@tabler/icons-react";',
                'export default function List(props: ListProps) {',
                '  const [q] = useState<ListProps>(null);',
                '  return (<div className="list">',
                '    <h1>Event types</h1>',
                '    <input placeholder="Search" />',
                '    <Button><IconPlus />New</Button>',
                '    <table><thead><tr><th>Name</th><th>Duration</th></tr></thead></table>',
                '    <p>Sorry, you are not allowed.</p>',
                '    <span>{t("hide_from_profile")}</span>',
                '    <RowMenu />',
                '  </div>);',
                '}',
            ].join('\n'),
            'src/pages/RowMenu.tsx': 'export default function RowMenu() { return <menu><button>Duplicate</button></menu>; }',
            'src/pages/Editor.tsx': 'export default function Editor() { return <div><button>Publish</button><button>Save draft</button><input placeholder="Add title" /></div>; }',
            'src/pages/Form.tsx': '<form><input name="title" /><input name="slug" /><input name="length" /><select name="location"></select><textarea name="description"></textarea><input name="price" /></form>',
            'src/layouts/main.tsx': 'import Sidebar from "../shell/Sidebar"; export default ({children}) => <div><Sidebar />{children}</div>;',
            'src/layouts/editor.tsx': 'export default ({children}) => <main>{children}</main>;',
            'src/shell/Sidebar.tsx': '<nav><a href="/">Dashboard</a><a href="/bookings">Bookings</a><a href="/availability">Availability</a><a href="/apps">Apps</a><a href="/settings">Settings</a></nav>',
            'src/shell/Topbar.tsx': '<header><span>Notifications</span></header>',
            'locales/en/common.json': { hide_from_profile: 'Hide from profile', duration_label: 'Duration' },
        },
        viewSources: {
            framework: 'nextjs',
            action_coverage: [
                { article_block_id: 'list', screenshot_block_id: 'list', kind: 'click', target: 'New', state: 'action-ready' },
            ],
            blocks: [
                { block_id: 'list', index: 0, layout: 'main', primary_view: 'src/pages/List.tsx',
                  partials_expanded: ['src/layouts/main.tsx', 'src/shell/Sidebar.tsx', 'locales/en/common.json'],
                  verbatim_evidence: ['Event types', 'New'], depicted_state: 'listing with the New button visible',
                  default_user_assumptions: [{ assumption: 'not read-only', markup_absence_check: ['read only'] }] },
                { block_id: 'editor', index: 1, layout: 'editor', primary_view: 'src/pages/Editor.tsx',
                  partials_expanded: [], verbatim_evidence: ['Publish'] },
                { block_id: 'ext', index: 2, external_surface: true, primary_view: 'src/pages/List.tsx', partials_expanded: [] },
                { block_id: 'nopng', index: 3, layout: 'main', primary_view: 'src/pages/List.tsx', partials_expanded: [] },
            ],
        },
        html: {
            list: '<!doctype html><html class="notranslate"><head><!-- INJECT_CSS --></head><body>' +
                '<aside class="hidden lg:flex"><nav><a>Dashboard</a><a>Bookings</a><a>Availability</a></nav></aside>' +
                '<main><h1>Event types</h1><input placeholder="Filter" /><button data-rtfm-action-target="list">New</button>' +
                '<table><tr><th>Name</th></tr></table></main></body></html>',
            editor: '<!doctype html><html><body><div class="editor"><button>Publish</button></div></body></html>',
            nopng: '<!doctype html><html><body><p>no png</p></body></html>',
        },
        pre: { list: true },
        png: { list: true, editor: true },
        lint: {
            framework: 'nextjs', project_dir: '.', global_errors: [], global_warnings: [], all_passed: true,
            metrics: { errors_total: 0, warnings_total: 1 },
            blocks: [
                { index: 0, block_id: 'list', primary_view: 'src/pages/List.tsx', errors: [],
                  warnings: ['only 5/12 (41%) of this mockup\'s class/id tokens match a selector in branding.css/mockup.css (unmatched: .foo, .bar). The branding bundle probably misses the stylesheet(s) for this surface.'],
                  metrics: {
                      shell_nav_labels: { hits: 3, total: 5, ratio: 0.6 },
                      chrome_files_expanded: { hits: 1, total: 2, ratio: 0.5 },
                      runtime_ui_strings: null, runtime_regions_rendered: null,
                      root_classes_html: { hits: 1, total: 1, ratio: 1 }, layout_root_classes: null,
                      verbatim_evidence_source: { hits: 2, total: 2, ratio: 1 }, verbatim_evidence_html: { hits: 2, total: 2, ratio: 1 },
                      partials_present: { hits: 3, total: 3, ratio: 1 }, body_class_tokens: null,
                      styled_coverage: { hits: 5, total: 12, ratio: 0.417 }, inline_classes_verified: null,
                      invented_colours: { count: 0 }, invented_copy: { count: 0 },
                  } },
                { index: 1, block_id: 'editor', primary_view: 'src/pages/Editor.tsx', errors: [], warnings: [],
                  metrics: { shell_nav_labels: { hits: 0, total: 5, ratio: 0 }, runtime_ui_strings: { hits: 1, total: 3, ratio: 0.333 },
                             invented_copy: { count: 0 } } },
            ],
        },
        diagnostics: {
            list: { qualityScore: { score: 97, rating: 'good', deductions: ['-3: 1 failed resource(s)'] },
                    metrics: { evidenceVisibility: [{ string: 'Event types', visible: true, visible_px: 900 }, { string: 'New', visible: true, visible_px: 300 }],
                               probeVisibility: [{ string: 'Dashboard', visible: false, visible_px: 0 }, { string: 'Bookings', visible: false, visible_px: 0 },
                                                 { string: 'Availability', visible: true, visible_px: 400 }, { string: 'Help centre', visible: false, visible_px: 0 }] } },
            editor: { qualityScore: { score: 45, rating: 'poor', deductions: ['-50: Appears blank'] }, metrics: { evidenceVisibility: [{ string: 'Publish', visible: true, visible_px: 200 }] } },
        },
        env: { RTFM_POLISH: 'on' },
    };
    if (mutate) mutate(ctx);
    write(path.join(root, '.rtfm', 'project_map.json'), ctx.projectMap);
    for (const [rel, contents] of Object.entries(ctx.sources)) write(path.join(root, rel), contents);
    if (ctx.viewSources) write(path.join(out, 'view_sources.json'), ctx.viewSources);
    if (ctx.lint) write(path.join(out, 'lint_report.json'), ctx.lint);
    for (const [id, html] of Object.entries(ctx.html)) {
        write(path.join(out, `block_${id}.html`), html);
        if (ctx.pre[id]) write(path.join(out, `block_${id}.html.pre`), html.replace('<body>', '<body data-raw="1">'));
        if (ctx.png[id]) fs.writeFileSync(path.join(out, `block_${id}.png`), PNG);
    }
    for (const [id, diag] of Object.entries(ctx.diagnostics)) write(path.join(out, `block_${id}_diagnostics.json`), diag);
    return ctx;
}
function kinds(ticket) { return ticket.questions.map(q => q.kind); }
function q(ticket, kind) { return ticket.questions.find(x => x.kind === kind); }
function byKey(tickets, key) { return tickets.blocks.find(b => b.key === key); }
function cli(args, env) {
    return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
}

// ── 1. The default fixture: every generator fires exactly where designed ──────
{
    const ctx = fixture();
    const t = buildTickets(ctx.out, ctx.root, ctx.env);
    assert.strictEqual(t.enabled, true);
    assert.deepStrictEqual(t.inputs, { view_sources: true, lint_report: true, project_map: true, app_shell: true });
    assert.deepStrictEqual(t.blocks.map(b => b.key).sort(), ['editor', 'list']);
    assert.deepStrictEqual(t.skipped.map(s => `${s.block}:${s.reason}`).sort(), ['ext:external-surface', 'nopng:no-png']);
    assert(t.blocks[0].counts.blocking >= t.blocks[1].counts.blocking, 'worst block first');
    assert.strictEqual(t.budget.max_edits, 6);

    const list = byKey(t, 'list');
    assert.strictEqual(list.html, 'block_list.html');
    assert.strictEqual(list.html_raw, 'block_list.html.pre', 'raw HTML named when a .pre exists');
    assert.strictEqual(list.png, 'block_list.png');
    assert(list.sha256.html && list.sha256.html_raw && list.sha256.png);
    assert.strictEqual(list.before.render_score, 97);
    assert.strictEqual(list.before.chrome, 0.7, 'mean of shell 0.6, chrome files 0.5, root classes 1');
    assert.deepStrictEqual(list.sources.read_order.slice(0, 1), ['src/pages/List.tsx'], 'primary view first');
    assert(list.sources.read_order.includes('src/shell/Topbar.tsx'), 'unexpanded chrome file still in read order');
    assert.strictEqual(list.sources.read_order[list.sources.read_order.length - 1], 'locales/en/common.json', 'locale files last');
    assert.deepStrictEqual(list.shell.nav_items, ['Dashboard', 'Bookings', 'Availability', 'Apps', 'Settings', 'Profile']);
    assert.deepStrictEqual(list.action_targets, [{ target: 'New', kind: 'click' }]);

    const k = kinds(list);
    assert.strictEqual(k.filter(x => x === 'compare').length, 1, 'exactly one compare question');
    assert.strictEqual(list.questions[list.questions.length - 1].kind, 'compare', 'compare question last');

    const shell = q(list, 'shell_labels_missing');
    assert(shell, 'shell labels 0.6 < 0.8 fires');
    assert.strictEqual(shell.severity, 'advisory', '0.6 ≥ 0.5 stays advisory');
    assert.deepStrictEqual(shell.missing, ['Apps', 'Settings'], 'names the ACTUAL missing top-level labels');
    assert(shell.text.includes('src/shell/Sidebar.tsx'), 'points at the layout chrome files');
    assert.deepStrictEqual(shell.check, { type: 'metric_ratio_min', key: 'shell_nav_labels', min: 0.8 });

    const paint = q(list, 'shell_not_painting');
    assert(paint, 'labels in the HTML but invisible in the probe → shell_not_painting');
    assert.strictEqual(paint.severity, 'blocking');
    assert.deepStrictEqual(paint.hidden, ['Dashboard', 'Bookings']);
    assert(paint.text.includes('paint 0 px'), paint.text);
    assert.deepStrictEqual(paint.check, { type: 'probe_visible_majority', strings: ['Dashboard', 'Bookings', 'Availability'] });
    assert(!q(list, 'shell_item_hidden'), 'majority hidden is the blocking kind, not the advisory one');

    const chrome = q(list, 'chrome_file_unexpanded');
    assert(chrome && chrome.severity === 'blocking');
    assert.deepStrictEqual(chrome.unexpanded, ['src/shell/Topbar.tsx']);

    const footer = q(list, 'shell_footer_missing');
    assert(footer && footer.check.strings.includes('Help centre'));
    const topBar = q(list, 'shell_top_bar_missing');
    assert(topBar, 'literal top-bar label absent → ticket');
    assert.deepStrictEqual(topBar.check.strings, ['Notifications'], 'prose top-bar items are never checked');

    const styled = q(list, 'styled_coverage_low');
    assert(styled && styled.text.includes('.foo'), 'quotes the lint\'s unmatched sample');
    assert(!q(list, 'render_quality'), 'failed-resource deductions alone never ticket');
    assert(!q(list, 'evidence_invisible') && !q(list, 'action_target_invisible'));

    const comp = q(list, 'source_component_unrendered');
    assert(comp, 'RowMenu leaves no trace → ticket');
    const names = comp.components.map(c => c.name);
    assert(names.includes('RowMenu'), names);
    assert.strictEqual(comp.components.find(c => c.name === 'RowMenu').file, 'src/pages/RowMenu.tsx', 'relative import resolved');
    for (const noise of ['ListProps', 'IconPlus', 'Button']) assert(!names.includes(noise), `${noise} must not be a component ticket`);

    const labels = q(list, 'source_labels_missing');
    assert(labels, 'labels ticket');
    for (const l of ['Duration', 'Search', 'Hide from profile']) assert(labels.labels.includes(l), `${l} expected in ${labels.labels}`);
    for (const l of ['Event types', 'Name', 'Sorry, you are not allowed.']) assert(!labels.labels.includes(l), `${l} must not be listed`);
    assert.strictEqual(labels.check.type, 'html_contains_any');
    assert(!q(list, 'source_form_fields_missing'), 'a list view with 1 source input never tickets form fields');
    assert(!q(list, 'source_nav_missing'), 'a rich app_shell suppresses the source-nav fallback');

    const editor = byKey(t, 'editor');
    assert(!q(editor, 'shell_labels_missing'), 'chrome: [] + runtime_chrome layout never grows a shell');
    assert.strictEqual(editor.shell, null);
    assert.strictEqual(editor.sources.layout.shell_hidden, true);
    const rs = q(editor, 'runtime_strings_missing');
    assert(rs && rs.severity === 'advisory');
    assert.deepStrictEqual(rs.missing, ['Save draft', 'Add title']);
    const rq = q(editor, 'render_quality');
    assert(rq && rq.severity === 'blocking' && rq.text.includes('Appears blank'));
    assert.deepStrictEqual(rq.check, { type: 'render_deductions_absent' });
    fs.rmSync(ctx.root, { recursive: true, force: true });
}

// ── 2. Thresholds at their boundaries ────────────────────────────────────────
{
    const at = (mutator) => { const c = fixture(mutator); const t = buildTickets(c.out, c.root, c.env); fs.rmSync(c.root, { recursive: true, force: true }); return t; };
    const setList = (ctx, fn) => fn(ctx.lint.blocks[0].metrics);
    assert(!q(byKey(at(c => setList(c, m => { m.shell_nav_labels = { hits: 4, total: 5, ratio: 0.8 }; })), 'list'), 'shell_labels_missing'), '0.8 does not fire');
    assert(q(byKey(at(c => setList(c, m => { m.shell_nav_labels = { hits: 4, total: 5, ratio: 0.79 }; })), 'list'), 'shell_labels_missing'), '0.79 fires');
    assert.strictEqual(q(byKey(at(c => setList(c, m => { m.shell_nav_labels = { hits: 2, total: 5, ratio: 0.4 }; })), 'list'), 'shell_labels_missing').severity, 'blocking', '< 0.5 is blocking');
    assert(!q(byKey(at(c => setList(c, m => { m.styled_coverage = { hits: 6, total: 10, ratio: 0.6 }; })), 'list'), 'styled_coverage_low'), '0.6 does not fire');
    assert(q(byKey(at(c => setList(c, m => { m.styled_coverage = { hits: 6, total: 10, ratio: 0.59 }; })), 'list'), 'styled_coverage_low'), '0.59 fires');
    assert(!q(byKey(at(c => setList(c, m => { m.styled_coverage = { hits: 3, total: 9, ratio: 0.333 }; })), 'list'), 'styled_coverage_low'), 'total < 10 never fires');
    assert(!q(byKey(at(c => { c.diagnostics.list.qualityScore = { score: 60, rating: 'fair', deductions: ['-40: 8 failed resource(s)'] }; }), 'list'), 'render_quality'), 'a low score from failed resources is not the model\'s');
    const cut = q(byKey(at(c => { c.diagnostics.list.qualityScore = { score: 85, rating: 'good', deductions: ['-15: Content taller than screenshot cap — bottom cut off'] }; }), 'list'), 'render_quality');
    assert(cut && cut.severity === 'advisory', 'a content deduction fires even at a good score');
    const chrome1 = at(c => setList(c, m => { m.chrome_files_expanded = { hits: 2, total: 2, ratio: 1 }; }));
    assert(!q(byKey(chrome1, 'list'), 'chrome_file_unexpanded'));
    const hiddenMinor = at(c => { c.diagnostics.list.metrics.probeVisibility[1].visible = true; });
    assert(!q(byKey(hiddenMinor, 'list'), 'shell_not_painting'), '1/3 hidden is not a majority');
    assert.deepStrictEqual(q(byKey(hiddenMinor, 'list'), 'shell_item_hidden').hidden, ['Dashboard']);
    const invisible = at(c => {
        c.diagnostics.list.metrics.evidenceVisibility = [{ string: 'Event types', visible: false }, { string: 'New', visible: false }];
        c.diagnostics.list.metrics.probeVisibility.push({ string: 'New', visible: false });
    });
    assert.strictEqual(q(byKey(invisible, 'list'), 'evidence_invisible').severity, 'blocking');
    assert.deepStrictEqual(q(byKey(invisible, 'list'), 'action_target_invisible').check.strings, ['New']);
    const lintErr = at(c => { c.lint.blocks[0].errors = ['this step claims layout \'main\' but never expanded its recorded chrome file(s): src/shell/Topbar.tsx.']; });
    assert.strictEqual(q(byKey(lintErr, 'list'), 'lint_error').severity, 'blocking');
    assert.strictEqual(byKey(lintErr, 'list').questions[0].kind, 'lint_error', 'lint errors come first');
    const invented = at(c => { c.lint.blocks[0].metrics.invented_copy = { count: 2 }; c.lint.blocks[0].warnings.push('2 multi-word phrase(s) in step_0.html do not appear in any listed source file or locale: "made up sentence here", "another one entirely"'); });
    assert(q(byKey(invented, 'list'), 'invented_copy').text.includes('"made up sentence here"'));
    const missingPartial = at(c => { c.lint.blocks[0].metrics.partials_present = { hits: 2, total: 3, ratio: 0.667 }; c.viewSources.blocks[0].partials_expanded.push('src/shell/Nope.tsx'); });
    assert(q(byKey(missingPartial, 'list'), 'partial_missing').text.includes('src/shell/Nope.tsx'));
}

// ── 3. Shell gating by layout, form fields, source-nav fallback, legacy steps ─
{
    const c1 = fixture(ctx => { ctx.projectMap.app_shell.layout = 'other'; });
    const t1 = buildTickets(c1.out, c1.root, c1.env);
    assert(!q(byKey(t1, 'list'), 'shell_labels_missing'), 'shell bound to another layout → no shell ticket');
    assert(byKey(t1, 'list').sources.layout.shell_hidden === true);
    fs.rmSync(c1.root, { recursive: true, force: true });

    const c2 = fixture(ctx => { ctx.projectMap.layouts[0].area = '60px top header ONLY — no left sidebar'; });
    const t2 = buildTickets(c2.out, c2.root, c2.env);
    assert(!q(byKey(t2, 'list'), 'shell_labels_missing'), 'layout prose says no sidebar → no shell ticket');
    fs.rmSync(c2.root, { recursive: true, force: true });

    const c3 = fixture(ctx => { ctx.viewSources.blocks[0].layout = undefined; });
    const t3 = buildTickets(c3.out, c3.root, c3.env);
    assert(!q(byKey(t3, 'list'), 'shell_labels_missing'), 'web block claiming no layout → no shell ticket');
    fs.rmSync(c3.root, { recursive: true, force: true });

    const c4 = fixture(ctx => { ctx.projectMap.app_type = 'mobile'; ctx.projectMap.layouts = []; ctx.viewSources.blocks[0].layout = undefined; });
    const t4 = buildTickets(c4.out, c4.root, c4.env);
    assert(q(byKey(t4, 'list'), 'shell_labels_missing'), 'non-web modes omit layout by contract — the shell still applies');
    fs.rmSync(c4.root, { recursive: true, force: true });

    const c5 = fixture(ctx => {
        ctx.viewSources.blocks.push({ block_id: 'form', index: 4, layout: 'main', primary_view: 'src/pages/Form.tsx', partials_expanded: [], verbatim_evidence: [] });
        ctx.html.form = '<html><body><form><input placeholder="Title" /></form></body></html>';
        ctx.png.form = true;
    });
    const t5 = buildTickets(c5.out, c5.root, c5.env);
    const ff = q(byKey(t5, 'form'), 'source_form_fields_missing');
    assert(ff, '6 source fields vs 1 rendered control → ticket');
    assert(ff.fields.includes('slug') && !ff.fields.includes('title'), `title is present by humanized name: ${ff.fields}`);
    assert.deepStrictEqual(ff.check, { type: 'html_control_count_min', min: 3 });
    fs.rmSync(c5.root, { recursive: true, force: true });

    const c6 = fixture(ctx => { ctx.projectMap.app_shell = null; });
    const t6 = buildTickets(c6.out, c6.root, c6.env);
    assert.strictEqual(t6.inputs.app_shell, false);
    const nav = q(byKey(t6, 'list'), 'source_nav_missing');
    assert(nav, 'thin map → navigation mined from the layout\'s own <nav>');
    assert(nav.check.strings.includes('Apps') && nav.check.strings.includes('Settings'));
    assert(!nav.check.strings.includes('Dashboard'), 'present labels are not listed');
    fs.rmSync(c6.root, { recursive: true, force: true });

    const c7 = fixture(ctx => {
        ctx.viewSources = { framework: 'rails', action_coverage: [{ article_step_index: 0, screenshot_step_index: 0, kind: 'click', target: 'New' }],
            steps: [{ index: 0, layout: 'main', primary_view: 'src/pages/List.tsx', partials_expanded: [], verbatim_evidence: ['Event types'] }] };
        ctx.lint.blocks = undefined; ctx.lint.steps = [{ index: 0, errors: [], warnings: [], metrics: { shell_nav_labels: { hits: 3, total: 5, ratio: 0.6 } } }];
        ctx.html = { }; ctx.pre = {}; ctx.png = {}; ctx.diagnostics = {};
    });
    write(path.join(c7.out, 'step_0.html'), c7.html.list || '<html><body><h1>Event types</h1><button>New</button></body></html>');
    fs.writeFileSync(path.join(c7.out, 'step_0.png'), PNG);
    const t7 = buildTickets(c7.out, c7.root, c7.env);
    assert.strictEqual(t7.blocks.length, 1);
    assert.strictEqual(t7.blocks[0].key, '0');
    assert.strictEqual(t7.blocks[0].html, 'step_0.html');
    assert.strictEqual(t7.blocks[0].block_id, null);
    assert.deepStrictEqual(t7.blocks[0].action_targets, [{ target: 'New', kind: 'click' }], 'index-keyed action coverage resolves in legacy mode');
    fs.rmSync(c7.root, { recursive: true, force: true });
}

// ── 4. Env gate, caps, missing inputs, CLI ───────────────────────────────────
{
    const c = fixture();
    const off = cli([c.out, c.root], { RTFM_POLISH: 'off' });
    assert.strictEqual(off.status, 0, off.stderr);
    assert(off.stdout.includes('polish: disabled'));
    const disabled = JSON.parse(fs.readFileSync(path.join(c.out, 'polish_tickets.json'), 'utf8'));
    assert.deepStrictEqual(disabled, { schema_version: 1, enabled: false, blocks: [], skipped: [] });
    assert(!fs.existsSync(path.join(c.out, 'polish_report.json')));
    const offReport = cli([c.out, c.root, '--report'], { RTFM_POLISH: '0' });
    assert(offReport.stdout.includes('polish: disabled'));
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(c.out, 'polish_report.json'), 'utf8')).enabled, false);

    const capped = buildTickets(c.out, c.root, { RTFM_POLISH_MAX_BLOCKS: '1', RTFM_POLISH_MAX_EDITS: '3' });
    assert.strictEqual(capped.blocks.length, 1);
    assert.strictEqual(capped.budget.max_edits, 3);
    assert.strictEqual(capped.blocks[0].budget.max_edits, 3);
    assert(capped.skipped.some(s => s.reason === 'over-block-cap'));

    const on = cli([c.out, c.root], { RTFM_POLISH: 'on' });
    assert.strictEqual(on.status, 0, on.stderr);
    assert(/polish: 2 block\(s\) ticketed, \d+ question\(s\), \d+ blocking/.test(on.stdout), on.stdout);
    assert(on.stdout.includes('Read block_list.png, then src/pages/List.tsx'), on.stdout);
    assert(on.stdout.includes('skipped ext: external-surface'));
    assert(on.stdout.includes('POLISH: 2 block(s) need a second look'), on.stdout);
    assert(!fs.readFileSync(path.join(c.out, 'block_list.html'), 'utf8').includes('data-raw="1"'), 'no --restore → injected HTML untouched');
    const restore = cli([c.out, c.root, '--restore'], { RTFM_POLISH: 'on' });
    assert.strictEqual(restore.status, 0, restore.stderr);
    assert(restore.stdout.includes('polish: 1 block(s) restored'), restore.stdout);
    assert(fs.readFileSync(path.join(c.out, 'block_list.html'), 'utf8').includes('data-raw="1"'), 'ticketed block with a .pre is restored to raw');
    assert(!fs.readFileSync(path.join(c.out, 'block_editor.html'), 'utf8').includes('data-raw'), 'a block without a .pre is left as is');
    const tAfterRestore = JSON.parse(fs.readFileSync(path.join(c.out, 'polish_tickets.json'), 'utf8'));
    assert.strictEqual(tAfterRestore.blocks.find(b => b.key === 'list').sha256.html_raw, byKey(tAfterRestore, 'list').sha256.html_raw);
    fs.writeFileSync(path.join(c.out, 'block_list.html'), c.html.list);   // back to the injected form for the report checks below

    // Report before any edit: nothing changed, checkable questions evaluated, compare excluded.
    const r0 = buildReport(c.out, c.root);
    assert.strictEqual(r0.enabled, true);
    const l0 = r0.blocks.find(b => b.key === 'list');
    assert.strictEqual(l0.html_changed, false);
    assert.strictEqual(l0.png_changed, false);
    assert(l0.checkable < l0.questions_total, 'the manual compare question is not checkable');
    assert(l0.questions.find(x => x.kind === 'compare').resolved === null);
    assert(l0.unresolved.some(u => u.kind === 'shell_labels_missing'));
    assert(l0.unresolved.some(u => u.kind === 'shell_not_painting'));
    assert.strictEqual(l0.render_before, 97);
    assert.strictEqual(l0.chrome_before, 0.7);

    // Simulate the polish: labels added to the raw + injected HTML, re-lint metrics up,
    // probe now sees the sidebar, a fresh PNG.
    const html = fs.readFileSync(path.join(c.out, 'block_list.html'), 'utf8').replace('<a>Availability</a>', '<a>Availability</a><a>Apps</a><a>Settings</a><a>Help centre</a>');
    fs.writeFileSync(path.join(c.out, 'block_list.html'), html);
    fs.writeFileSync(path.join(c.out, 'block_list.html.pre'), html.replace('<body>', '<body data-raw="1">'));
    fs.writeFileSync(path.join(c.out, 'block_list.png'), Buffer.concat([PNG, Buffer.from('new')]));
    const lint = JSON.parse(fs.readFileSync(path.join(c.out, 'lint_report.json'), 'utf8'));
    lint.blocks[0].metrics.shell_nav_labels = { hits: 5, total: 5, ratio: 1 };
    lint.blocks[0].metrics.chrome_files_expanded = { hits: 2, total: 2, ratio: 1 };
    write(path.join(c.out, 'lint_report.json'), lint);
    const diag = JSON.parse(fs.readFileSync(path.join(c.out, 'block_list_diagnostics.json'), 'utf8'));
    for (const p of diag.metrics.probeVisibility) p.visible = true;
    diag.qualityScore.score = 98;
    write(path.join(c.out, 'block_list_diagnostics.json'), diag);

    const rep = cli([c.out, c.root, '--report'], { RTFM_POLISH: 'on' });
    assert.strictEqual(rep.status, 0, rep.stderr);
    assert(/polish: 2 block\(s\) ticketed, \d+ question\(s\) \(\d+ checkable\) — resolved \d+\/\d+; HTML changed 1\/2, PNG changed 1\/2/.test(rep.stdout), rep.stdout);
    const r1 = JSON.parse(fs.readFileSync(path.join(c.out, 'polish_report.json'), 'utf8'));
    const l1 = r1.blocks.find(b => b.key === 'list');
    assert.strictEqual(l1.html_changed, true, 'raw HTML sha moved');
    assert.strictEqual(l1.png_changed, true);
    assert.strictEqual(l1.render_after, 98);
    assert.strictEqual(l1.chrome_after, 1);
    for (const kind of ['shell_labels_missing', 'shell_not_painting', 'chrome_file_unexpanded', 'shell_footer_missing']) {
        assert.strictEqual(l1.questions.find(x => x.kind === kind).resolved, true, `${kind} resolved after the edit`);
    }
    assert.strictEqual(l1.questions.find(x => x.kind === 'styled_coverage_low').resolved, false, 'untouched metric stays unresolved');
    assert(r1.totals.resolved > r0.totals.resolved);
    assert.strictEqual(r1.totals.blocks_html_changed, 1);
    fs.rmSync(c.root, { recursive: true, force: true });

    // Missing inputs degrade, never fail.
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'rtfm-polish-bare-'));
    const noVs = cli([bare, bare], { RTFM_POLISH: 'on' });
    assert.strictEqual(noVs.status, 0);
    const tb = JSON.parse(fs.readFileSync(path.join(bare, 'polish_tickets.json'), 'utf8'));
    assert.strictEqual(tb.enabled, true);
    assert.deepStrictEqual(tb.blocks, []);
    assert.deepStrictEqual(tb.skipped, [{ reason: 'no-view-sources' }]);
    const noTickets = cli([bare, bare, '--report'], { RTFM_POLISH: 'on' });
    assert.strictEqual(noTickets.status, 0);
    fs.rmSync(path.join(bare, 'polish_tickets.json'));
    const orphanReport = cli([bare, bare, '--report'], { RTFM_POLISH: 'on' });
    assert.strictEqual(orphanReport.status, 0);
    assert(JSON.parse(fs.readFileSync(path.join(bare, 'polish_report.json'), 'utf8')).error);
    fs.rmSync(bare, { recursive: true, force: true });
    const nowhere = cli([path.join(os.tmpdir(), 'rtfm-polish-does-not-exist')], { RTFM_POLISH: 'on' });
    assert.strictEqual(nowhere.status, 0);
    assert(nowhere.stdout.includes('Usage'));

    // No project map at all: no shell questions, source questions still fire.
    const c8 = fixture();
    fs.rmSync(path.join(c8.root, '.rtfm'), { recursive: true, force: true });
    const t8 = buildTickets(c8.out, c8.root, c8.env);
    assert.strictEqual(t8.inputs.project_map, false);
    assert(!q(byKey(t8, 'list'), 'shell_labels_missing'));
    assert(q(byKey(t8, 'list'), 'source_labels_missing'));
    assert(q(byKey(t8, 'list'), 'compare'));
    fs.rmSync(c8.root, { recursive: true, force: true });
}

// ── 5. Screen closure ticket: unconditional pieces of the primary view that the mockup lacks ──
{
    const c = fixture(ctx => {
        ctx.sources['src/pages/Form.erb'] = [
            '<%= render partial: "shared/header_bar" %>',
            '<h3>Session details</h3><label>Session title</label>',
            '<h3>Session options</h3><label>Record session</label>',
            '<% if @premium %><h3>Premium extras</h3><label>Priority support</label><% end %>',
            '<%= render partial: "modals/pick_contact_modal" %>',
        ].join('\n');
        ctx.sources['src/shared/_header_bar.html.erb'] = '<button>Save draft</button>';
        ctx.sources['src/modals/_pick_contact_modal.html.erb'] = '<div class="modal"><h5>Pick a contact</h5></div>';
        ctx.viewSources.blocks.push({ block_id: 'form', index: 4, layout: 'main', primary_view: 'src/pages/Form.erb', partials_expanded: [], verbatim_evidence: [] });
        ctx.html.form = '<html><body><main><h3>Session details</h3><label>Session title</label></main></body></html>';
        ctx.png.form = true;
    });
    const t = buildTickets(c.out, c.root, c.env);
    const tk = q(byKey(t, 'form'), 'screen_piece_missing');
    assert(tk, 'missing unconditional pieces → ticket');
    const labels = tk.pieces.map(p => p.label);
    assert(labels.some(l => l.includes('Session options')) && labels.some(l => l.includes('shared/header_bar')), labels);
    assert(!labels.some(l => l.includes('Premium extras')) && !labels.some(l => l.includes('pick_contact')), 'guarded + overlay pieces are exempt');
    assert.strictEqual(tk.severity, 'blocking', 'any missing unconditional piece is blocking');
    assert.strictEqual(tk.check.type, 'html_contains_any');
    fs.rmSync(c.root, { recursive: true, force: true });

    // One of three missing is still blocking — the list only ever holds pieces the real screen shows.
    const c2 = fixture(ctx => {
        ctx.sources['src/pages/Form.erb'] = '<%= render partial: "shared/header_bar" %>\n<h3>Session details</h3><label>Session title</label>\n<h3>Session options</h3><label>Record session</label>';
        ctx.sources['src/shared/_header_bar.html.erb'] = '<button>Save draft</button>';
        ctx.viewSources.blocks.push({ block_id: 'form', index: 4, layout: 'main', primary_view: 'src/pages/Form.erb', partials_expanded: [], verbatim_evidence: [] });
        ctx.html.form = '<html><body><button>Save draft</button><h3>Session details</h3>Session title</body></html>';
        ctx.png.form = true;
    });
    const t2 = buildTickets(c2.out, c2.root, c2.env);
    const tk2 = q(byKey(t2, 'form'), 'screen_piece_missing');
    assert(tk2 && tk2.severity === 'blocking' && tk2.pieces.length === 1 && tk2.pieces[0].label.includes('Session options'), JSON.stringify(tk2));
    fs.rmSync(c2.root, { recursive: true, force: true });
}

console.log('polish_tickets tests passed');
