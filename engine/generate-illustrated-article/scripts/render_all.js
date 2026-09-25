#!/usr/bin/env node
/**
 * render_all.js — render every step_*.html in a directory to PNG using ONE
 * warm Puppeteer browser with concurrent tabs, instead of a browser launch
 * per screenshot (which is what the old per-file render_mockup.js loop cost).
 *
 * Also logs per-step and total durations so render time is measurable — it's
 * the last tool call in a run, so trace-gap timing can't see it.
 *
 * Usage: render_all.js <dir> [concurrency]
 *   <dir>          directory containing step_*.html; PNGs land beside them
 *   [concurrency]  max simultaneous tabs (default 1 — concurrent tabs rendering
 *                  CSS-heavy mockups stall Chromium's renderer until the ~180s
 *                  protocol timeout in containers; sequential renders on the
 *                  warm browser take well under a second each)
 *
 * Exit code 0 even if individual steps fail (matches the old loop's
 * `|| echo failed` behaviour); failures are reported per step.
 */

const fs = require('fs');
const path = require('path');
const { puppeteer, launchOptions, renderOnBrowser, probeStringsFor } = require('./render_mockup.js');

async function main() {
    const dir = process.argv[2];
    const concurrency = Math.max(1, parseInt(process.argv[3], 10) || 1);
    if (!dir || !fs.statSync(dir).isDirectory()) {
        console.error('Usage: render_all.js <dir> [concurrency]');
        process.exit(1);
    }

    const htmlFiles = fs.readdirSync(dir)
        .filter(f => /^(?:step_\d+|block_[a-z0-9]+(?:-[a-z0-9]+)*)\.html$/.test(f))
        .sort()
        .map(f => path.join(dir, f));

    if (htmlFiles.length === 0) {
        console.log('No article mockup HTML files found — nothing to render.');
        return;
    }

    // Per-step verbatim evidence from view_sources.json (when present): the
    // renderer verifies each string actually PAINTS inside the cropped frame.
    // The lint's text-level checks cannot see computed layout — a step whose
    // subject is clipped/collapsed passes every input-side gate and ships a
    // blank frame. Entries are strings (web/desktop) or {string} objects
    // (mobile l10n evidence); both are handled.
    const evidenceByStep = {};
    let viewSources = null;
    try {
        const vs = JSON.parse(fs.readFileSync(path.join(dir, 'view_sources.json'), 'utf8'));
        viewSources = vs;
        for (const step of vs.blocks || vs.steps || []) {
            const ev = (step.verbatim_evidence || [])
                .map(e => (typeof e === 'string' ? e : (e && e.string) || ''))
                .filter(Boolean);
            if (ev.length) evidenceByStep[step.block_id || step.index] = ev;
        }
    } catch { /* no view_sources.json — render without the evidence gate */ }
    // Probe strings come from the project map's app_shell. The article dir is
    // <root>/output/articles/<slug>, and the skill runs from <root>; try both.
    const projectRoot = [path.resolve(dir, '..', '..', '..'), process.cwd()].find(root =>
        ['.rtfm', '.rtfm-branding'].some(d => fs.existsSync(path.join(root, d, 'project_map.json')))
    ) || process.cwd();

    const t0 = Date.now();
    const browser = await puppeteer.launch(launchOptions());
    const launchMs = Date.now() - t0;

    const results = [];
    try {
        // Simple worker pool: N tabs in flight at once.
        let next = 0;
        async function worker() {
            while (next < htmlFiles.length) {
                const htmlFile = htmlFiles[next++];
                const png = htmlFile.replace(/\.html$/, '.png');
                const start = Date.now();
                const match = path.basename(htmlFile).match(/^(?:step_(\d+)|block_([a-z0-9]+(?:-[a-z0-9]+)*))\.html$/);
                const stepIdx = match && (match[1] || match[2]);
                try {
                    const evidence = evidenceByStep[stepIdx] || evidenceByStep[Number(stepIdx)];
                    const probe = probeStringsFor(projectRoot, viewSources, stepIdx, evidence);
                    const diag = await renderOnBrowser(browser, png, htmlFile, { evidence, probe });
                    results.push({
                        file: path.basename(htmlFile),
                        ok: true,
                        ms: Date.now() - start,
                        quality: diag.qualityScore.rating,
                        score: diag.qualityScore.score,
                        geometry_errors: ((diag.metrics || {}).regionGeometry || {}).errors || [],
                        evidence_invisible: ((diag.metrics || {}).evidenceVisibility || [])
                            .filter(e => !e.visible).map(e => e.string),
                        evidence_checked: ((diag.metrics || {}).evidenceVisibility || []).length,
                    });
                } catch (err) {
                    results.push({
                        file: path.basename(htmlFile),
                        ok: false,
                        ms: Date.now() - start,
                        error: err.message,
                    });
                }
            }
        }
        await Promise.all(
            Array.from({ length: Math.min(concurrency, htmlFiles.length) }, worker)
        );
    } finally {
        await browser.close();
    }

    const totalMs = Date.now() - t0;
    results.sort((a, b) => a.file.localeCompare(b.file));
    for (const r of results) {
        if (r.ok) {
            console.log(`  ${r.file} -> png in ${r.ms}ms (quality: ${r.quality}, ${r.score})`);
        } else {
            console.log(`  ${r.file} FAILED in ${r.ms}ms: ${r.error}`);
        }
    }
    const failed = results.filter(r => !r.ok).length;
    console.log(`Rendered ${results.length - failed}/${results.length} step(s) in ${totalMs}ms ` +
        `(browser launch ${launchMs}ms, ${concurrency} tab(s))${failed ? ` — ${failed} FAILED` : ''}`);
    // A "poor" diagnostic almost always means the PNG is unusable (blank/collapsed
    // content) even though the render itself succeeded — say so loudly instead of
    // letting the quiet per-line score read as done. Exit code stays 0 on purpose:
    // the model fixes the mockup and re-runs; a hard failure here would abort the
    // whole post-process block.
    for (const r of results) {
        if (r.ok && r.quality === 'poor') {
            console.log(`STOP: ${r.file.replace(/\.html$/, '.png')} rendered POOR (score ${r.score}) — ` +
                'the screenshot is likely blank or collapsed. Fix that mockup and re-run render_all before finishing.');
        }
    }

    // Evidence-visibility gate: a MAJORITY of a step's verbatim-evidence
    // strings not painting inside the cropped frame means the step's subject
    // is clipped or collapsed (below the window fold, zero-height pane, …) —
    // the screenshot does not show what the step is about, however faithful
    // the markup. Majority (not any) so a single stray string in a tooltip
    // or duplicate label doesn't false-positive. Same loud-STOP-exit-0
    // convention as the POOR gate above.
    for (const r of results) {
        if (r.ok && r.evidence_checked
            && r.evidence_invisible.length * 2 > r.evidence_checked) {
            console.log(`STOP: ${r.file.replace(/\.html$/, '.png')} does not SHOW this step's subject — ` +
                `${r.evidence_invisible.length}/${r.evidence_checked} evidence strings paint zero visible pixels ` +
                `(${r.evidence_invisible.map(s => JSON.stringify(s)).join(', ')}). The content exists in the HTML ` +
                'but is clipped out of frame or collapsed to zero size. Depict the state where the subject is ' +
                'visible (scroll the content, fix the pane layout) and re-run render_all before finishing.');
        }
    }

    const geometryFailed = results.filter(r => r.ok && r.geometry_errors && r.geometry_errors.length).length;
    if (geometryFailed) {
        console.log(`STOP: ${geometryFailed} step(s) violate the schema-v2 runtime-region geometry contract.`);
        for (const r of results.filter(x => x.geometry_errors && x.geometry_errors.length)) {
            console.log(`  ${r.file}: ${r.geometry_errors.join('; ')}`);
        }
    }

    fs.writeFileSync(path.join(dir, 'render_timing.json'), JSON.stringify({
        total_ms: totalMs,
        browser_launch_ms: launchMs,
        concurrency,
        all_passed: failed === 0 && geometryFailed === 0,
        steps: results,
    }, null, 2));
    if (failed || geometryFailed) process.exitCode = 1;
}

main().catch(err => {
    console.error('render_all failed:', err.message);
    process.exit(1);
});
