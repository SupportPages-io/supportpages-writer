#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rtfm-render-ready-'));
const out = path.join(root, 'output', 'articles', 'progressive-article');
const cache = path.join(root, '.rtfm');
fs.mkdirSync(out, { recursive: true });
fs.mkdirSync(cache, { recursive: true });

// The shell nav carries one visible label and one the mockup hides with
// display:none — the ungated probe must report the first visible and the
// second not (the cal.com "sidebar in the HTML, 0 px in the PNG" class).
const html = '<!doctype html><html><head><meta charset="utf-8"><!-- INJECT_CSS --></head>' +
    '<body data-viewport="wide" style="margin:0;background:#fff;color:#111">' +
    '<nav><a href="#">Dashboard</a><a href="#" style="display:none">Hidden Reports</a></nav>' +
    '<main style="width:640px;padding:48px"><h1>Progress ready</h1>' +
    '<button data-rtfm-action-target="0">Publish</button></main></body></html>';
fs.writeFileSync(path.join(out, 'step_0.html'), html);
fs.writeFileSync(path.join(out, 'view_sources.json'), JSON.stringify({
    framework: 'test',
    action_coverage: [{ article_step_index: 0, screenshot_step_index: 0, target: 'Publish', kind: 'click' }],
    steps: [{ index: 0, verbatim_evidence: ['Progress ready', 'Publish'] }],
}));
fs.writeFileSync(path.join(cache, 'project_map.json'), JSON.stringify({
    app_type: 'web',
    app_shell: {
        type: 'sidebar',
        nav_items: [{ label: 'Dashboard', href: '/' }, { label: 'Hidden Reports', href: '/reports' }],
        footer_items: [{ label: 'Help centre' }],
    },
}));
fs.writeFileSync(path.join(cache, 'images_base64.json'), JSON.stringify({ images: {} }));
fs.writeFileSync(path.join(cache, 'branding.json'), JSON.stringify({
    framework: 'terminal',
    default_colors: { primary: '#111111', background: '#ffffff' },
    compiled_css_path: 'branding.css',
}));
fs.writeFileSync(path.join(cache, 'branding.css'), 'body{font-family:Arial,sans-serif}button{padding:8px 12px}');

const script = path.join(__dirname, 'render_ready.js');
const result = spawnSync(process.execPath, [script, out, '0', root], {
    encoding: 'utf8',
    env: { ...process.env, RTFM_WATERMARK: 'off' },
    maxBuffer: 10 * 1024 * 1024,
});
assert.strictEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
assert.strictEqual(fs.readFileSync(path.join(out, 'step_0.html'), 'utf8'), html,
    'progress render must restore authorable HTML');
const png = fs.readFileSync(path.join(out, 'step_0.png'));
assert.strictEqual(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
assert(fs.existsSync(path.join(out, 'step_0_diagnostics.json')));
const diagnostics = JSON.parse(fs.readFileSync(path.join(out, 'step_0_diagnostics.json'), 'utf8'));
const probe = Object.fromEntries((diagnostics.metrics.probeVisibility || []).map(p => [p.string, p]));
assert.strictEqual(probe['Dashboard'] && probe['Dashboard'].visible, true, 'visible nav label must probe visible');
assert.strictEqual(probe['Hidden Reports'] && probe['Hidden Reports'].visible, false, 'display:none nav label must probe invisible');
assert.strictEqual(probe['Help centre'] && probe['Help centre'].visible, false, 'absent footer label must probe invisible');
assert(!('Publish' in probe), 'evidence strings are measured by the evidence gate, not the probe');
assert.strictEqual(diagnostics.metrics.evidenceVisibility.every(e => e.visible), true);
assert(fs.existsSync(path.join(out, 'step_0_validation.json')));
assert(fs.existsSync(path.join(out, 'step_0_progress.json')));
assert(!fs.readdirSync(out).some(name => name.includes('.rendering-')));

const blockOut = path.join(root, 'output', 'articles', 'concept-article');
fs.mkdirSync(blockOut, { recursive: true });
const blockHtml = html.replace('data-rtfm-action-target="0"', 'data-rtfm-action-target="how-it-works"');
fs.writeFileSync(path.join(blockOut, 'block_how-it-works.html'), blockHtml);
fs.writeFileSync(path.join(blockOut, 'view_sources.json'), JSON.stringify({
    framework: 'test', action_coverage: [],
    blocks: [{ block_id: 'how-it-works', verbatim_evidence: ['Progress ready', 'Publish'] }],
}));
const blockResult = spawnSync(process.execPath, [script, blockOut, 'how-it-works', root], {
    encoding: 'utf8', env: { ...process.env, RTFM_WATERMARK: 'off' }, maxBuffer: 10 * 1024 * 1024,
});
assert.strictEqual(blockResult.status, 0, `${blockResult.stdout}\n${blockResult.stderr}`);
assert.strictEqual(fs.readFileSync(path.join(blockOut, 'block_how-it-works.html'), 'utf8'), blockHtml);
assert(fs.existsSync(path.join(blockOut, 'block_how-it-works.png')));
const progress = JSON.parse(fs.readFileSync(path.join(blockOut, 'block_how-it-works_progress.json'), 'utf8'));
assert.strictEqual(progress.block_id, 'how-it-works');

fs.rmSync(root, { recursive: true, force: true });
console.log('render_ready progressive publication test passed');
