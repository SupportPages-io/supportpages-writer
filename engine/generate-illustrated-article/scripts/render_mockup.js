#!/usr/bin/env node
/**
 * Mockup Renderer
 *
 * Renders an HTML mockup to PNG using Puppeteer with quality detection,
 * adaptive viewport, and diagnostics JSON.
 *
 * Frame size: the preset named by <body data-viewport="…"> (default `web`,
 * 1480×900 — the PC-class size shared with the desktop window frame).
 * `web` and `exact` presets capture exactly the viewport; every other preset
 * crops to the measured content extent + 48px (framed modes — ios/android/
 * macos/windows/game — and terminal's `wide` rely on that crop for symmetric
 * margins around a variable-height frame).
 *
 * Notes:
 *   - Resolves puppeteer relative to this script's location (so the skill works
 *     regardless of the cwd it's invoked from).
 *   - Drops the /usr/bin/chromium executablePath default — Puppeteer uses its
 *     bundled Chromium that npm installed.
 *
 * Usage: render_mockup.js <output_png> <html_file>
 */

const Module = require('module');
const path = require('path');
const fs = require('fs');

// Resolve puppeteer from the script's own node_modules, not the cwd's.
const scriptNodeModules = path.join(__dirname, '..', 'node_modules');
Module.globalPaths.unshift(scriptNodeModules);

// Packaged installs hoist dependencies to a parent node_modules instead, which
// ordinary resolution from this directory finds.
function loadPuppeteer() {
    try { return require(path.join(scriptNodeModules, 'puppeteer')); }
    catch (error) {
        if (error.code !== 'MODULE_NOT_FOUND') throw error;
        return require('puppeteer');
    }
}
const puppeteer = loadPuppeteer();
const { WATERMARK_TEXT_SCREENSHOT, WATERMARK_FONT, watermarkMetrics, isWatermarkEnabled } = require('./watermark.js');
const { measureRuntimeRegionGeometry } = require('./runtime_region_geometry.js');

const VIEWPORTS = {
    mobile: { width: 375, height: 667 }, // legacy responsive-web preset — NOT for device-frame mockups (use ios/android)
    // Device-frame presets (mobile-app mode): width = device outer width + 96 so the
    // centered .device-stage (48px padding) yields symmetric 48px margins under the
    // content crop. iOS outer 417px, Android outer 432px (see device-frame.css).
    // Heights must exceed the framed device's bottom edge (48px stage padding +
    // outer frame height) — content below the viewport height does not paint.
    ios: { width: 513, height: 1008 },
    android: { width: 528, height: 1072 },
    // Window-frame presets (desktop-app mode): same margin math — width 1576 =
    // .desktop-window 1480 + 96 (48px .desktop-stage padding each side; the
    // crop is width-capped at the viewport). Height carries ~100px headroom
    // over the window bottom (48 + 900 + 48 = 996): content below the viewport
    // height does not paint, so zero headroom would turn any 1px overflow into
    // a blank strip in the crop. The window matches the `web` preset so every
    // PC-class capture (browser, Electron/Tauri, Win32, macOS) is the same size.
    macos: { width: 1576, height: 1100 },
    windows: { width: 1576, height: 1100 },
    // Playfield preset (game mode): width 1296 = max .game-screen 1200 + 96.
    // The .game-stage is LEFT-aligned (flex-start) at 48px padding, so the
    // content crop (maxRight/maxBottom + 48) yields symmetric 48px margins for
    // ANY per-game display_size — unlike the centered device/window stages
    // there is no fixed frame width to center against. Height 1100 clears the
    // fit-height maximum (48 + 900 = 948 content bottom) with ~150px headroom;
    // content below the viewport height does not paint. Deliberately NOT
    // exact:true — display sizes vary per game and the content crop handles
    // them; exact would freeze dead space around smaller screens.
    game: { width: 1296, height: 1100 },
    tablet: { width: 768, height: 1024 },
    desktop: { width: 800, height: 600 }, // legacy responsive-web preset — NOT for window-frame mockups (use macos/windows)
    // Web-app preset (and the default when a mockup carries no data-viewport):
    // the PNG IS the viewport — 1480×900 logical, like a browser screenshot on
    // a typical laptop (16:10; Bootstrap xxl, Tailwind xl, MUI lg — 56px clear
    // of every framework breakpoint, so no layout sits on a knife edge).
    // viewportCrop (vs exact) keeps the watermark band APPENDED below the
    // frame rather than overlaid. Motivation: the content-extent crop grew
    // past the viewport on tall pages while position:fixed overlays (a modal
    // + its backdrop, a sticky header) stay viewport-sized, so a modal step
    // rendered dimmed for the top 800px and undimmed below. Content past the
    // fold is simply not in the screenshot — the contract tells the model to
    // depict the scrolled state, and the evidence-visibility gate enforces it.
    web: { width: 1480, height: 900, viewportCrop: true },
    // Content-cropped 960×800 — terminal mockups (the window height follows the
    // row count) and any legacy web mockup that set it explicitly. 960 gives a
    // ~100-column window: wide enough for real CLI output, narrow enough that a
    // ~750px help-centre column shows the monospace text at a readable size
    // (at 1200 it scaled to ~9px and short prompts filled half the window).
    wide: { width: 960, height: 800 },
    terminal: { width: 600, height: 400 },
    tui: { width: 720, height: 480 },
    social: { width: 1200, height: 630, exact: true },
};

const BASE_FALLBACK_CSS = `

@font-face {
    font-family: 'Inter';
    src: local('Inter'), local('system-ui'), local('-apple-system'), local('BlinkMacSystemFont');
    font-weight: 100 900;
}
@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap');
.tui-app, .tui-container, [data-viewport="tui"] body {
    font-family: 'JetBrains Mono', 'Fira Code', 'SF Mono', Monaco, 'Cascadia Code', monospace !important;
}
`;

// Glyph substitutes for icon-font classes. Uses !important, so it must NOT
// be injected when inject_assets embedded the real icon fonts (marked via
// data-rtfm-icon-fonts on <html>).
const ICON_FALLBACK_CSS = `
.fa, .fas, .far, .fab, [class^="fa-"], [class*=" fa-"] {
    font-family: system-ui, -apple-system, sans-serif !important;
}
.fa-check::before, .fa-check-circle::before { content: "\\2713" !important; }
.fa-times::before, .fa-times-circle::before, .fa-close::before { content: "\\2717" !important; }
.fa-arrow-right::before { content: "\\2192" !important; }
.fa-arrow-left::before { content: "\\2190" !important; }
.fa-arrow-up::before { content: "\\2191" !important; }
.fa-arrow-down::before { content: "\\2193" !important; }
.fa-plus::before { content: "+" !important; }
.fa-minus::before { content: "\\2212" !important; }
.fa-search::before { content: "\\1F50D" !important; }
.fa-user::before { content: "\\1F464" !important; }
.fa-cog::before, .fa-gear::before { content: "\\2699" !important; }
.fa-home::before { content: "\\1F3E0" !important; }
.fa-envelope::before, .fa-mail::before { content: "\\2709" !important; }
.fa-edit::before, .fa-pencil::before { content: "\\270E" !important; }
.fa-trash::before { content: "\\1F5D1" !important; }
.fa-star::before { content: "\\2605" !important; }
.fa-warning::before, .fa-exclamation-triangle::before { content: "\\26A0" !important; }
.fa-info::before, .fa-info-circle::before { content: "\\2139" !important; }
.fa-lock::before { content: "\\1F512" !important; }
.fa-eye::before { content: "\\1F441" !important; }
.fa-copy::before { content: "\\1F4CB" !important; }
.fa-spinner::before { content: "\\21BB" !important; }
.fa-refresh::before, .fa-sync::before { content: "\\21BB" !important; }
.fa-link::before { content: "\\1F517" !important; }
.fa-calendar::before { content: "\\1F4C5" !important; }
.fa-clock::before { content: "\\1F550" !important; }
.fa-file::before { content: "\\1F4C4" !important; }
.fa-folder::before { content: "\\1F4C1" !important; }
.fa-github::before { content: "\\1F4BB" !important; }
.fa-sort::before { content: "\\21C5" !important; }
.fa-bars::before { content: "\\2630" !important; }
.fa-chevron-down::before, .fa-caret-down::before, .fa-angle-down::before { content: "\\25BE" !important; }
.fa-chevron-up::before, .fa-caret-up::before, .fa-angle-up::before { content: "\\25B4" !important; }
.fa-chevron-right::before, .fa-angle-right::before { content: "\\203A" !important; }
.fa-chevron-left::before, .fa-angle-left::before { content: "\\2039" !important; }
.fa-ellipsis::before, .fa-ellipsis-h::before { content: "\\2026" !important; }
.fa-phone::before { content: "\\260E" !important; }
.fa-comment::before, .fa-comments::before { content: "\\1F4AC" !important; }
.fa-bell::before { content: "\\1F514" !important; }
.fa-question-circle::before, .fa-circle-question::before { content: "?" !important; }
.fa-filter::before { content: "\\25E2" !important; }
.fa-download::before { content: "\\2913" !important; }
.fa-upload::before { content: "\\2912" !important; }
.fa-sign-out::before, .fa-sign-out-alt::before, .fa-right-from-bracket::before { content: "\\21AA" !important; }
.bi, [class^="bi-"], [class*=" bi-"] {
    font-family: system-ui, -apple-system, sans-serif !important;
}
[class*="bi-house"]::before { content: "\\1F3E0" !important; }
[class*="bi-person"]::before { content: "\\1F464" !important; }
[class*="bi-gear"]::before { content: "\\2699" !important; }
[class*="bi-envelope"]::before { content: "\\2709" !important; }
[class*="bi-pencil"]::before { content: "\\270E" !important; }
[class*="bi-trash"]::before { content: "\\1F5D1" !important; }
[class*="bi-search"]::before { content: "\\1F50D" !important; }
[class*="bi-plus"]::before { content: "+" !important; }
[class*="bi-check"]::before { content: "\\2713" !important; }
[class*="bi-x-"]::before, .bi-x::before { content: "\\2717" !important; }
[class*="bi-calendar"]::before { content: "\\1F4C5" !important; }
[class*="bi-clock"]::before { content: "\\1F550" !important; }
[class*="bi-telephone"]::before { content: "\\260E" !important; }
[class*="bi-chat"]::before { content: "\\1F4AC" !important; }
[class*="bi-bell"]::before { content: "\\1F514" !important; }
[class*="bi-chevron-down"]::before { content: "\\25BE" !important; }
[class*="bi-chevron-right"]::before { content: "\\203A" !important; }
[class*="bi-list"]::before { content: "\\2630" !important; }
[class*="bi-star"]::before { content: "\\2605" !important; }
[class*="bi-info"]::before { content: "\\2139" !important; }
[class*="bi-exclamation"]::before { content: "\\26A0" !important; }
`;

function getViewportFromHtml(html) {
    const m = html.match(/data-viewport=["'](\w+)["']/i);
    const type = m ? m[1].toLowerCase() : 'web';
    return VIEWPORTS[type] || VIEWPORTS.web;
}

function calculateQualityScore(metrics, pageErrors, failedResources) {
    let score = 100;
    const deductions = [];
    if (pageErrors.length > 0) {
        const d = Math.min(pageErrors.length * 10, 30);
        score -= d;
        deductions.push(`-${d}: ${pageErrors.length} page error(s)`);
    }
    if (failedResources.length > 0) {
        const d = Math.min(failedResources.length * 3, 15);
        score -= d;
        deductions.push(`-${d}: ${failedResources.length} failed resource(s)`);
    }
    if (metrics.isLikelyBlank) {
        score -= 50;
        deductions.push('-50: Appears blank');
    }
    if (metrics.visibleElementCount < 3) {
        score -= 10;
        deductions.push('-10: Very few visible elements');
    }
    if (metrics.isClipped) {
        score -= 15;
        deductions.push('-15: Content taller than screenshot cap — bottom cut off');
    }
    const geometryErrors = (metrics.regionGeometry && metrics.regionGeometry.errors) || [];
    if (geometryErrors.length) {
        const d = Math.min(geometryErrors.length * 20, 60);
        score -= d;
        deductions.push(`-${d}: ${geometryErrors.length} runtime-region geometry error(s)`);
    }
    const rating = geometryErrors.length ? 'poor' : (score >= 80 ? 'good' : score >= 50 ? 'acceptable' : 'poor');
    return { score: Math.max(0, Math.min(100, score)), rating, deductions };
}

function launchOptions() {
    const launchOpts = {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-web-security',
            '--disable-crash-reporter',
        ],
    };
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
        launchOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    }
    return launchOpts;
}

// Render one HTML file to PNG on an existing browser (one tab per call, so
// several renders can share a single warm browser — see render_all.js).
async function renderOnBrowser(browser, outputPath, htmlFile, opts = {}) {
    const html = fs.readFileSync(htmlFile, 'utf8').trim();
    if (!html) {
        throw new Error('No HTML content in file');
    }

    const viewport = getViewportFromHtml(html);
    const pageErrors = [];
    const consoleMessages = [];
    const failedResources = [];
    const loadedResources = [];

    let renderMetrics = {};

    const blockedExternal = [];
    const stageTimings = {};
    let stageStart = Date.now();
    const stage = (name) => { stageTimings[name] = Date.now() - stageStart; stageStart = Date.now(); };

    const page = await browser.newPage();
    stage('newPage');
    try {
        // Mockups are self-contained (CSS inlined, images as data URIs, icon
        // fallbacks injected below) — block all external requests so renders
        // are deterministic and never stall on unreachable CDNs/fonts.
        await page.setRequestInterception(true);
        page.on('request', req => {
            const url = req.url();
            if (/^(file|data|about|blob):/.test(url)) return req.continue();
            blockedExternal.push(url);
            req.abort('blockedbyclient');
        });

        page.on('pageerror', err => pageErrors.push(err.message));
        page.on('console', msg => {
            if (msg.text().includes('ERR_BLOCKED_BY_CLIENT')) return; // deliberate block, not a page defect
            consoleMessages.push({ type: msg.type(), text: msg.text() });
            if (msg.type() === 'error') pageErrors.push(msg.text());
        });
        page.on('requestfinished', req => loadedResources.push({ url: req.url(), resourceType: req.resourceType() }));
        page.on('requestfailed', req => {
            const reason = req.failure()?.errorText || 'Unknown';
            if (reason === 'net::ERR_BLOCKED_BY_CLIENT') return; // deliberate block
            failedResources.push({
                url: req.url(),
                resourceType: req.resourceType(),
                reason,
            });
        });

        await page.setViewport({ width: viewport.width, height: viewport.height, deviceScaleFactor: 2 });
        stage('setViewport');

        const fileUrl = `file://${path.resolve(htmlFile)}`;
        await page.goto(fileUrl, { waitUntil: 'networkidle0', timeout: 15000 }).catch(() => {
            console.warn('Network idle timeout, falling back to domcontentloaded');
            return page.goto(fileUrl, { waitUntil: 'domcontentloaded', timeout: 5000 });
        });
        stage('goto');

        // Glyph substitutes only when real icon fonts weren't embedded by
        // inject_assets (marked via data-rtfm-icon-fonts on <html>).
        const hasRealIconFonts = await page.evaluate(
            () => document.documentElement.hasAttribute('data-rtfm-icon-fonts')
        );
        await page.addStyleTag({ content: BASE_FALLBACK_CSS });
        if (!hasRealIconFonts) {
            await page.addStyleTag({ content: ICON_FALLBACK_CSS });
        }
        stage('addStyleTag');

        // Measure the true content extent: the max bottom/right edge across all
        // visible elements. body.boundingBox() is wrong here — fixed/absolutely
        // positioned elements (modal overlays, dropdowns) don't contribute to the
        // body's in-flow height, so a mockup showing a modal taller than the page
        // behind it would get cropped mid-modal.
        const contentExtent = await page.evaluate(() => {
            // Clip each element's rect against its overflow-hidden/clip ancestors:
            // content inside a fixed-size frame (.device-screen, .desktop-window)
            // is painted clipped, so it must not inflate the crop (an Electron
            // renderer's #root{height:100vh} inside a 800px window would otherwise
            // add a blank strip below the frame). position:fixed elements escape
            // ordinary ancestor clipping per CSS and keep the modal-taller-than-
            // page behaviour this measurement exists for — EXCEPT inside an
            // ancestor with paint containment (.game-screen): containment makes
            // that ancestor the containing block and clips its paint, so nothing
            // escapes visually and the crop must not grow past it (a game's real
            // fixed-position UI container is bigger than the display screen).
            let maxBottom = 0;
            let maxRight = 0;
            for (const el of document.querySelectorAll('body, body *')) {
                const style = window.getComputedStyle(el);
                if (style.display === 'none' || style.visibility === 'hidden') continue;
                let rect = el.getBoundingClientRect();
                if (rect.width === 0 && rect.height === 0) continue;
                let { bottom, right } = rect;
                const isFixed = style.position === 'fixed';
                for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
                    const as = window.getComputedStyle(a);
                    if (as.display === 'none' || as.visibility === 'hidden' || parseFloat(as.opacity || '1') === 0) { bottom = top; break; }
                    const clips = /(hidden|clip)/.test(as.overflow + as.overflowX + as.overflowY);
                    const containsPaint = /(paint|strict|content)/.test(as.contain || '');
                    if ((clips && !isFixed) || containsPaint) {
                        const ar = a.getBoundingClientRect();
                        bottom = Math.min(bottom, ar.bottom);
                        right = Math.min(right, ar.right);
                    }
                }
                maxBottom = Math.max(maxBottom, bottom + window.scrollY);
                maxRight = Math.max(maxRight, right + window.scrollX);
            }
            return { maxBottom, maxRight };
        });
        stage('contentExtent');

        renderMetrics = await page.evaluate(() => {
            const body = document.body;
            const rect = body.getBoundingClientRect();
            const computedStyle = window.getComputedStyle(body);
            const visibleElements = document.querySelectorAll('div, p, h1, h2, h3, h4, h5, h6, span, button, input, form, table, ul, ol, li, img, a, nav, header, footer, section, article');
            const textContent = body.innerText.trim();
            const images = document.querySelectorAll('img');
            const loadedImages = Array.from(images).filter(img => img.complete && img.naturalWidth > 0);
            return {
                width: rect.width,
                height: rect.height,
                hasChildren: body.children.length > 0,
                childCount: body.children.length,
                visibleElementCount: visibleElements.length,
                hasTextContent: textContent.length > 0,
                textLength: textContent.length,
                backgroundColor: computedStyle.backgroundColor,
                imageCount: images.length,
                loadedImageCount: loadedImages.length,
            };
        });

        renderMetrics.regionGeometry = await page.evaluate(measureRuntimeRegionGeometry);

        renderMetrics.isLikelyBlank =
            renderMetrics.width < 10 ||
            renderMetrics.height < 10 ||
            (!renderMetrics.hasChildren && !renderMetrics.hasTextContent) ||
            (renderMetrics.visibleElementCount === 0 && renderMetrics.textLength === 0);

        let screenshotWidth, screenshotHeight;
        if (viewport.exact || viewport.viewportCrop) {
            // The frame is the viewport. Content below the fold is cut, exactly
            // as a browser screenshot would — record it so a step whose subject
            // sits below the fold is diagnosable (the evidence-visibility gate
            // below is what actually fails it).
            screenshotWidth = viewport.width;
            screenshotHeight = viewport.height;
            const contentHeight = Math.ceil(contentExtent.maxBottom);
            renderMetrics.contentHeight = contentHeight;
            renderMetrics.isClipped = contentHeight > viewport.height;
            if (renderMetrics.isClipped) {
                console.warn(`Warning: content extends ${contentHeight - viewport.height}px below the ${viewport.height}px viewport — the screenshot shows the viewport only; depict the scrolled state if the step's subject sits below the fold`);
            }
        } else {
            const MIN_HEIGHT = 300;
            const MAX_HEIGHT = 2400;
            const contentHeight = Math.ceil(contentExtent.maxBottom) + 48;
            screenshotHeight = Math.min(Math.max(contentHeight, MIN_HEIGHT), MAX_HEIGHT);
            screenshotWidth = Math.min(Math.ceil(contentExtent.maxRight) + 48, viewport.width);
            renderMetrics.isClipped = contentHeight > MAX_HEIGHT;
            if (renderMetrics.isClipped) {
                console.warn(`Warning: content height ${contentHeight}px exceeds the ${MAX_HEIGHT}px cap — bottom of mockup will be cut off`);
            }
        }

        stage('metrics');

        // Evidence-visibility gate: the lint proves each step's verbatim
        // evidence exists in the HTML TEXT; this proves it paints inside the
        // CROPPED FRAME. The two can diverge silently — computed layout is only
        // observable in the render (observed: a faithful Settings copy whose
        // target section sat below the desktop window's overflow clip, and a
        // bones-misassembled shell whose main pane rendered zero-height; both
        // lint-green, both blank where it mattered). Same clip-ancestor logic
        // as the content-extent measurement above; a string is visible if ANY
        // occurrence paints ≥1px² inside the crop.
        if (Array.isArray(opts.evidence) && opts.evidence.length) {
            renderMetrics.evidenceVisibility = await measureStringVisibility(
                page, opts.evidence, screenshotHeight, screenshotWidth);
            stage('evidenceVisibility');
        }
        // Probe strings (shell nav/footer labels + this step's action targets):
        // measured, NEVER gated. The lint's shell_nav_labels metric is text
        // presence only — a sidebar copied faithfully from the source with a
        // `hidden lg:flex` class pair can pass 4/4 and still paint 0 px
        // (seen on a Next.js scheduling app). The polish phase reads this to ask "the
        // shell is in your HTML but not in your screenshot".
        if (Array.isArray(opts.probe) && opts.probe.length) {
            renderMetrics.probeVisibility = await measureStringVisibility(
                page, opts.probe, screenshotHeight, screenshotWidth);
            stage('probeVisibility');
        }

        let outputHeight = screenshotHeight;
        renderMetrics.watermark = isWatermarkEnabled();
        if (renderMetrics.watermark) {
            // Watermark band — composited in a SECOND screenshot pass, never
            // injected into the mockup DOM. Injecting an absolutely-positioned
            // element is not paint-safe: e.g. Framework7 sets body
            // { position: relative; overflow-x: hidden }, which makes body both
            // the containing block and a clip container, so a band placed below
            // the content lands in body's scrollable overflow and never paints.
            // Instead: screenshot the untouched content, then setContent a
            // minimal composite page (block <img> + flow band below it) and
            // screenshot that. The composite has no mockup CSS to fight, so it
            // works identically across every app-type frame. The page viewport
            // (dSF 2) still applies, and the img at logical size maps 1:1 to
            // the source capture's physical pixels. For exact-frame presets
            // (social) the frame must not grow, so the band overlays the
            // bottom of the image instead of appending below it.
            // viewportCrop frames (web) append the band like content-cropped
            // renders do — the frame may grow; only truly exact frames overlay.
            const overlay = !!viewport.exact;
            // Same physical-pixel sizing rule as the walkthrough video strip,
            // so a mobile PNG and a mobile video carry an identically-sized
            // strip. PNGs always render at dSF 2 (setViewport above).
            const { stripHeight, fontSize } = watermarkMetrics(viewport.height, 2);
            const shot = await page.screenshot({
                type: 'png',
                encoding: 'base64',
                clip: { x: 0, y: 0, width: screenshotWidth, height: screenshotHeight },
            });
            const bandCss =
                (overlay ? 'position:absolute;left:0;bottom:0;' : '') +
                'display:flex;align-items:center;justify-content:center;box-sizing:border-box;' +
                `width:${screenshotWidth}px;height:${stripHeight}px;margin:0;padding:0;` +
                `background:${overlay ? 'rgba(15,23,42,0.82)' : '#0f172a'};` +
                `color:rgba(255,255,255,0.92);font:500 ${fontSize}px/1 ${WATERMARK_FONT};letter-spacing:0.02em;`;
            await page.setContent(
                '<!doctype html><html><body style="margin:0;padding:0;position:relative">' +
                `<img style="display:block;width:${screenshotWidth}px;height:${screenshotHeight}px" ` +
                `src="data:image/png;base64,${shot}">` +
                `<div style="${bandCss}">${WATERMARK_TEXT_SCREENSHOT}</div></body></html>`
            );
            if (!overlay) outputHeight += stripHeight;
        }
        await page.screenshot({
            path: outputPath,
            type: 'png',
            clip: { x: 0, y: 0, width: screenshotWidth, height: outputHeight },
        });
        stage('screenshot');
        console.log(`Stage timings for ${path.basename(outputPath)}: ${JSON.stringify(stageTimings)}`);

        console.log(`Rendered ${path.basename(outputPath)}: ${screenshotWidth}x${outputHeight}px (viewport: ${viewport.width}x${viewport.height})`);

        if (renderMetrics.isLikelyBlank) console.warn('Warning: Rendered image appears blank');
        if (failedResources.length > 0) console.warn(`Warning: ${failedResources.length} resource(s) failed to load`);
    } finally {
        await page.close().catch(() => {});
    }

    const diagnostics = {
        timestamp: new Date().toISOString(),
        viewport,
        metrics: renderMetrics,
        pageErrors,
        failedResources,
        blockedExternalResources: blockedExternal,
        stageTimings,
        loadedResourceCount: loadedResources.length,
        qualityScore: calculateQualityScore(renderMetrics, pageErrors, failedResources),
    };

    const diagnosticsPath = outputPath.replace(/\.png$/, '_diagnostics.json');
    fs.writeFileSync(diagnosticsPath, JSON.stringify(diagnostics, null, 2));
    return diagnostics;
}

// For each string: does its text, button value, or accessibly named control paint ≥1px² inside the
// cropped frame? Same clip-ancestor logic as the content-extent measurement.
// Shared by the evidence gate and the (ungated) probe.
async function measureStringVisibility(page, strings, cropBottom, cropRight) {
    return page.evaluate((strings, cropBottom, cropRight) => {
        const norm = s => String(s).replace(/\s+/g, ' ').trim();
        const results = [];
        const all = Array.from(document.querySelectorAll('body, body *'));
        for (const str of strings) {
            const needle = norm(str);
            if (!needle) continue;
            let visible = false;
            let bestArea = 0;
            let matchKind = null;
            for (const el of all) {
                const textMatch = norm(el.textContent || '').includes(needle);
                const valueMatch = el.matches('input[type=submit], input[type=button], input[type=reset]')
                    && norm(el.value) === needle;
                const control = el.matches('button, a[href], a[data-rtfm-action-target], a[data-bs-toggle], a[data-toggle], input:not([type=hidden]), select, textarea, [role=button], [role=link], [role=checkbox], [role=switch], [role=menuitem], [role=combobox], [role=tab]');
                const labelledBy = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
                    .map(id => document.getElementById(id)?.textContent || '').join(' ');
                const accessibleName = norm(labelledBy) || norm(el.getAttribute('aria-label') || '');
                const namedControl = control && accessibleName === needle;
                if (!textMatch && !valueMatch && !namedControl) continue;
                // deepest match only — a wrapper containing the string via a
                // child doesn't paint the text itself
                let deepest = true;
                if (!valueMatch && !namedControl) for (const c of el.children) {
                    if (norm(c.textContent || '').includes(needle)) { deepest = false; break; }
                }
                if (!deepest) continue;
                const style = window.getComputedStyle(el);
                if (style.display === 'none' || style.visibility === 'hidden'
                    || parseFloat(style.opacity || '1') === 0) continue;
                const rect = el.getBoundingClientRect();
                if (rect.width === 0 || rect.height === 0) continue;
                let { top, left, bottom, right } = rect;
                const isFixed = style.position === 'fixed';
                for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
                    const as = window.getComputedStyle(a);
                    if (as.display === 'none' || as.visibility === 'hidden' || parseFloat(as.opacity || '1') === 0) { bottom = top; break; }
                    const clips = /(hidden|clip)/.test(as.overflow + as.overflowX + as.overflowY);
                    const containsPaint = /(paint|strict|content)/.test(as.contain || '');
                    if ((clips && !isFixed) || containsPaint) {
                        const ar = a.getBoundingClientRect();
                        top = Math.max(top, ar.top);
                        left = Math.max(left, ar.left);
                        bottom = Math.min(bottom, ar.bottom);
                        right = Math.min(right, ar.right);
                    }
                }
                top = Math.max(top + window.scrollY, 0);
                left = Math.max(left + window.scrollX, 0);
                bottom = Math.min(bottom + window.scrollY, cropBottom);
                right = Math.min(right + window.scrollX, cropRight);
                const area = Math.max(0, bottom - top) * Math.max(0, right - left);
                bestArea = Math.max(bestArea, area);
                if (area >= 1) { visible = true; matchKind = valueMatch ? 'input_value' : namedControl ? 'accessible_control' : 'text'; break; }
            }
            results.push({ string: needle, visible, visible_px: Math.round(bestArea), match_kind: matchKind });
        }
        return results;
    }, strings, cropBottom, cropRight);
}

// The probe string set for one step: the app shell's nav/footer labels (with
// children) plus this step's action_coverage targets, minus strings already in
// the evidence set (measured separately) and anything under 3 chars. Reads the
// project map from <projectRoot>/.rtfm (or the legacy .rtfm-branding). Returns
// [] when there is no map or no shell — the probe is purely additive.
function probeStringsFor(projectRoot, viewSources, blockKey, evidence) {
    const labels = new Set();
    const add = v => { if (typeof v === 'string' && v.trim().length >= 3) labels.add(v.trim()); };
    for (const dir of ['.rtfm', '.rtfm-branding']) {
        try {
            const pm = JSON.parse(fs.readFileSync(path.join(projectRoot, dir, 'project_map.json'), 'utf8'));
            const shell = pm.app_shell || {};
            const walk = items => {
                for (const it of Array.isArray(items) ? items : []) {
                    if (!it) continue;
                    add(typeof it === 'string' ? it : it.label);
                    if (it && Array.isArray(it.children)) walk(it.children);
                }
            };
            walk(shell.nav_items);
            walk(shell.footer_items);
            break;
        } catch { /* try the next dir */ }
    }
    // action_coverage keys screenshots by block id (v1.43+) or by step index
    // (v1.41–42); the block entry itself carries both, so resolve through it.
    const vs = viewSources || {};
    const entries = vs.blocks || vs.steps || [];
    const block = entries.find(b => b && (String(b.block_id) === String(blockKey)
        || (b.block_id === undefined && String(b.index) === String(blockKey)))) || null;
    const keys = new Set([String(blockKey)]);
    if (block) {
        if (block.block_id !== undefined) keys.add(String(block.block_id));
        if (block.index !== undefined) keys.add(String(block.index));
    }
    for (const entry of Array.isArray(vs.action_coverage) ? vs.action_coverage : []) {
        if (!entry) continue;
        const key = entry.screenshot_block_id ?? entry.screenshot_step_index;
        if (key !== undefined && keys.has(String(key))) add(entry.target);
    }
    const seen = new Set((evidence || []).map(s => String(s).replace(/\s+/g, ' ').trim()));
    return [...labels].filter(s => !seen.has(s.replace(/\s+/g, ' ').trim()));
}

// Single-file CLI mode: launch a browser, render, close. render_all.js
// requires this module instead and shares one browser across all steps.
async function renderMockup(outputPath, htmlFile) {
    const browser = await puppeteer.launch(launchOptions());
    try {
        return await renderOnBrowser(browser, outputPath, htmlFile);
    } finally {
        await browser.close();
    }
}

module.exports = { puppeteer, launchOptions, renderOnBrowser, measureStringVisibility, probeStringsFor };

if (require.main === module) {
    const outputPath = process.argv[2];
    const htmlFile = process.argv[3];

    if (!outputPath || !htmlFile) {
        console.error('Usage: render_mockup.js <output_png> <html_file>');
        process.exit(1);
    }

    renderMockup(outputPath, htmlFile)
        .then(diag => {
            if (diag.qualityScore.rating === 'poor') {
                console.error(`Warning: Render quality is poor (score: ${diag.qualityScore.score})`);
            }
        })
        .catch(err => {
            console.error('Error rendering mockup:', err.message);
            process.exit(1);
        });
}
