#!/usr/bin/env node
'use strict';

// Tests for the Node scripts that replaced the Python ports and jq filters:
// check_article_json, trace_hook, extract_images and inject_assets.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { check } = require('./check_article_json.js');
const { record } = require('./trace_hook.js');
const { walk, signature } = require('./extract_images.js');
const {
    buildCssHeadBlock, desktopWindowBgBridge, fixedOffsetBridgeCss, fontDescriptorToUrl,
    firstGoogleFontFamily, injectCss, findLogo,
} = require('./inject_assets.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'article-ports-'));
const run = (script, args, options = {}) => spawnSync(process.execPath, [path.join(__dirname, script), ...args], { encoding: 'utf8', ...options });

// check_article_json
{
    const article = {
        schema_version: 2, title: 'Invite a teammate', article_type: 'how-to',
        blocks: [
            { id: 'lead', type: 'prose', presentation: 'lead', content: 'Add people to your workspace.' },
            { id: 'open-settings', type: 'section', presentation: 'numbered', title: 'Open settings', content: 'Click Settings.', has_image: false },
            { id: 'tips', type: 'list', presentation: 'tips', title: 'Tips', items: ['Use work email'] },
        ],
    };
    assert.deepStrictEqual(check(article), []);
    const broken = structuredClone(article);
    broken.blocks[1].id = 'lead';
    broken.blocks[0].content = 'Run ```npm i```';
    broken.blocks[2].presentation = 'grid';
    const problems = check(broken).join('\n');
    assert.match(problems, /duplicate block id/);
    assert.match(problems, /code fence/);
    assert.match(problems, /presentation must be one of bullets, checklist, tips/);
    assert.match(check({ ...article, blocks: [] }).join('\n'), /non-empty array/);
}

// trace_hook: record shape and the run-scoped append.
{
    const entry = record({ session_id: 's', tool_name: 'Bash', tool_input: { command: 'x'.repeat(600), path: 'src' } }, new Date('2026-09-22T10:00:00.123Z'));
    assert.deepStrictEqual(Object.keys(entry), ['ts', 'session', 'tool', 'file', 'pattern', 'path', 'glob', 'command']);
    assert.strictEqual(entry.ts, '2026-09-22T10:00:00Z');
    assert.strictEqual(entry.command.length, 500);
    assert.strictEqual(entry.path, 'src');
    assert.strictEqual(entry.file, null);

    const cwd = fs.mkdtempSync(path.join(tmp, 'trace-'));
    const payload = JSON.stringify({ cwd, tool_name: 'Read', tool_input: { file_path: '/a.md' } });
    assert.strictEqual(run('trace_hook.js', [], { input: payload }).status, 0);
    assert(!fs.existsSync(path.join(cwd, '.rtfm-trace')), 'no trace outside a run');
    fs.mkdirSync(path.join(cwd, '.rtfm-trace'));
    fs.writeFileSync(path.join(cwd, '.rtfm-trace', 'CURRENT'), 'my-run\textra\n');
    assert.strictEqual(run('trace_hook.js', [], { input: payload }).status, 0);
    assert.strictEqual(run('trace_hook.js', [], { input: 'not json' }).status, 0);
    const lines = fs.readFileSync(path.join(cwd, '.rtfm-trace', 'my-run.ndjson'), 'utf8').trim().split('\n');
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(JSON.parse(lines[0]).file, '/a.md');
}

// extract_images: priority names first, fingerprinted copies and skipped dirs excluded.
{
    const repo = fs.mkdtempSync(path.join(tmp, 'repo-'));
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    fs.mkdirSync(path.join(repo, 'public'));
    fs.mkdirSync(path.join(repo, 'node_modules'));
    fs.writeFileSync(path.join(repo, 'public', 'photo.png'), Buffer.concat([png, Buffer.alloc(10)]));
    fs.writeFileSync(path.join(repo, 'public', 'logo.png'), Buffer.concat([png, Buffer.alloc(50)]));
    fs.writeFileSync(path.join(repo, 'public', `logo-${'a'.repeat(21)}-${'b'.repeat(21)}.png`), png);
    fs.writeFileSync(path.join(repo, 'node_modules', 'dep.png'), png);
    const found = walk(repo);
    assert.deepStrictEqual(found.map(item => item.relPath), [path.join('public', 'logo.png'), path.join('public', 'photo.png')]);
    assert.match(signature(found), /^[0-9a-f]{64}$/);

    const manifest = path.join(tmp, 'images.json');
    assert.strictEqual(run('extract_images.js', [repo, manifest, '--cache']).status, 0);
    const images = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    assert.strictEqual(images.count, 2);
    assert(images.images['/assets/logo.png'].startsWith('data:image/png;base64,'));
    assert.match(run('extract_images.js', [repo, manifest, '--cache']).stdout, /cache hit \(2 images\)/);
}

// inject_assets: head block, fonts and bridges.
{
    assert.strictEqual(buildCssHeadBlock(null, null), '<script src="https://cdn.tailwindcss.com"></script>');
    const head = buildCssHeadBlock(null, {
        framework: 'bootstrap', compiled_css_path: 'branding.css',
        google_fonts: [{ family: 'Plus Jakarta Sans', weights: ['500', '700'] }, 'Inter'],
        default_colors: { primary: '#123456', text_muted: '#999' },
    });
    assert(head.startsWith('<link rel="stylesheet" href="branding.css">'));
    assert(head.includes('family=Plus+Jakarta+Sans:wght@500;700&display=swap'));
    assert(head.includes('family=Inter&display=swap'));
    assert(head.includes("--walkthrough-card-font: 'Plus Jakarta Sans'"), 'descriptor fonts name the title-card font');
    assert(head.includes('--brand-text-muted: #999;'));
    assert(!head.includes('cdn.tailwindcss.com'), 'compiled non-Tailwind CSS needs no CDN');
    assert.strictEqual(firstGoogleFontFamily({ google_fonts: ['https://fonts.googleapis.com/css2?family=Open+Sans:wght@400'] }), 'Open Sans');
    assert.strictEqual(fontDescriptorToUrl(''), null);

    assert.match(desktopWindowBgBridge('body.theme-dark { color: red; background: #111; }'), /body\.theme-dark \.desktop-window-content \{ background: #111; \}/);
    assert.strictEqual(desktopWindowBgBridge('.card { background: red; }'), '');
    const offset = fixedOffsetBridgeCss('<html class="wp-toolbar"><body>', 'html.wp-toolbar{padding-top:32px}');
    assert(offset.includes('html.wp-toolbar{padding-top:0 !important;}[data-walkthrough-stage]{padding-top:32px;}'));
    assert.strictEqual(fixedOffsetBridgeCss('<html class="other">', 'html.wp-toolbar{padding-top:32px}'), '');

    // Replacement text is literal: "$&" in CSS must survive.
    assert.strictEqual(injectCss('<head><!-- INJECT_CSS --></head>', '<style>a[href$="&"]{}</style>'), '<head><style>a[href$="&"]{}</style></head>');
    assert.strictEqual(findLogo({ 'logo-dark.png': 1, 'logo.svg': 2, 'favicon-logo.png': 3, 'brandmark.png': 4 }), 'logo.svg');
}

// inject_assets end to end: idempotent injection, image tokens, walkthrough stage and cards.
{
    const cwd = fs.mkdtempSync(path.join(tmp, 'project-'));
    const out = path.join(cwd, 'out');
    fs.mkdirSync(out);
    const step = '<!doctype html><html><head><!-- INJECT_CSS --></head><body><img src="{{img:logo.png}}"><p>{{img:missing.png}}</p></body></html>';
    fs.writeFileSync(path.join(out, 'step_0.html'), step);
    fs.writeFileSync(path.join(out, 'actions.json'), JSON.stringify({ steps: [{ action: 'click' }] }));
    fs.writeFileSync(path.join(out, 'article.json'), JSON.stringify({ title: 'Export a table', introduction: 'Save rows <fast>.', summary: '' }));
    const images = path.join(cwd, 'images.json');
    fs.writeFileSync(images, JSON.stringify({ images: { 'public/logo.svg': 'data:image/svg+xml;base64,PHN2Zy8+', 'logo.png': 'data:image/png;base64,AAAA' } }));

    const first = run('inject_assets.js', [out, '', images, '--walkthrough', path.join(out, 'actions.json')], { cwd });
    assert.strictEqual(first.status, 0, first.stderr);
    const html = fs.readFileSync(path.join(out, 'step_0.html'), 'utf8');
    assert(html.includes('<!-- RTFM_CSS_INJECTED -->'));
    assert(html.includes('src="data:image/png;base64,AAAA"'));
    assert(html.includes('{{img:missing.png}}'), 'unknown images are left for the lint to report');
    assert(html.includes('<div data-walkthrough-stage="1"'));
    assert(html.includes('data-walkthrough-wipe-in="1"'));
    assert.strictEqual(fs.readFileSync(path.join(out, 'step_0.html.pre'), 'utf8'), step);
    const intro = fs.readFileSync(path.join(out, 'step_intro.html'), 'utf8');
    assert(intro.includes('Save rows &lt;fast&gt;.'));
    assert(intro.includes('src="data:image/png;base64,AAAA"'), 'the repo logo is embedded');
    assert(!fs.readFileSync(path.join(out, 'step_outro.html'), 'utf8').includes('walkthrough-card-tagline"'), 'an empty summary has no tagline');

    // Re-running on injected HTML must not stack a second CSS block.
    assert.strictEqual(run('inject_assets.js', [out, '', images], { cwd }).status, 0);
    assert.strictEqual(fs.readFileSync(path.join(out, 'step_0.html'), 'utf8').split('<!-- RTFM_CSS_INJECTED -->').length, 2);
    assert.strictEqual(run('inject_assets.js', [out, ''], { cwd }).status, 2);
    assert.strictEqual(run('inject_assets.js', [path.join(cwd, 'nope'), '', images], { cwd }).status, 1);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('node port tests passed');
