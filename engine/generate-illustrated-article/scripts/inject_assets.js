#!/usr/bin/env node
'use strict';

/*
 * inject_assets.js — Post-process generated mockup HTML files.
 *
 * Shared by generate-illustrated-article (no --walkthrough) and generate-walkthrough
 * (--walkthrough). generate-walkthrough/scripts/inject_assets.js is a symlink to this
 * file; the two skills differ only by the --walkthrough flag (see below). Keep both
 * modes working when editing.
 *
 * For each step_*.html / block_*.html in <html_dir>:
 *   - Replace <!-- INJECT_CSS --> with framework CDN / compiled CSS / Tailwind
 *     fallback (see "CSS source resolution" below). Injection is idempotent — a
 *     RTFM_CSS_INJECTED sentinel lets STEP-4 lint-retry re-runs skip re-injecting.
 *   - Render-time JIT: when project_map.json has a `css_build` recipe, compile the
 *     mockups' own classes into <html_dir>/mockup.css (jit_mockup_css.js) and link
 *     it in place of the flaky Play CDN. Skips cleanly with no recipe. Runs in BOTH
 *     modes, so walkthroughs get the same JIT fidelity as articles.
 *   - Replace {{img:filename}} tokens with project image data URIs from <images_json>.
 *   - Replace {{generated:id}} tokens with generated-image files declared by the
 *     optional --generated-images manifest.
 *
 * With --walkthrough <actions_json>, also inject:
 *   - A zoomable stage wrapper (<div data-walkthrough-stage>) around the mockup.
 *   - Polish CSS: target glow, click ripple, page-transition fade overlay.
 *   - Auto-generates step_intro.html / step_outro.html title cards from
 *     article.json (skipping the stage wrapper on those pages).
 *
 * The step text is carried by the narration + subtitles/transcript, so no
 * on-screen caption chrome is injected.
 *
 * With --branding <branding_json>, build a richer head block layered as:
 *   1. App's compiled CSS (if branding.compiled_css_path is set) — highest fidelity
 *   2. Framework CDN (Bootstrap / Bulma / Foundation / Tailwind) if no compiled CSS
 *   3. Tailwind runtime config override (if framework is tailwind + extend present)
 *   4. Bare Tailwind CDN fallback for tailwind/none/custom frameworks
 *   5. Google Fonts <link>s from branding.google_fonts
 *   6. External stylesheets from branding.external_stylesheets
 *   7. <style data-walkthrough-branding> with :root vars + default colours + CSS-var overrides
 *
 * CSS source resolution (without --branding):
 *   - If <css_file_or_empty> is a non-empty file → wrap in <style>
 *   - Otherwise → Tailwind CDN
 *
 * Usage:
 *     node inject_assets.js <html_dir> <css_file_or_empty> <images_json> \
 *       [--walkthrough <actions_json>] [--branding <branding_json>]
 *       [--generated-images <generated_images_json>] [--refresh-jit]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const TAILWIND_CDN = '<script src="https://cdn.tailwindcss.com"></script>';
// Sentinel marking a mockup whose <!-- INJECT_CSS --> block has already been
// replaced. STEP 4's lint-retry re-runs processDir on already-injected HTML;
// the marker lets us skip re-injecting so the block never stacks 2nd/3rd time.
const INJECTED_SENTINEL = '<!-- RTFM_CSS_INJECTED -->';

// All walkthrough-specific styling lives in one block so it can be injected
// once per page. Includes: page-transition overlay (bidirectional —
// class-driven), pre-click target glow, click ripple effect, title-card
// layout. Branding CSS vars (--brand-primary etc.) are produced earlier by
// buildCssHeadBlock and referenced here with safe fallbacks.
const WALKTHROUGH_STYLE = [
    '<style data-walkthrough-polish="1">',
    // ── Page-transition overlay ───────────────────────────────────────
    // body::before sits below caption (9999) and cursor (10000) but above
    // mockup content, giving us a fade-in on page load and a fade-out
    // before navigation. Class-driven so the recorder can run it in
    // either direction. The fallback colour is white when no brand
    // colour is set; with a brand colour it becomes a soft brand wash.
    'body::before{',
    "content:'';",
    'position:fixed;top:0;left:0;right:0;bottom:0;',
    'background:color-mix(in srgb,var(--brand-primary,#ffffff) 22%,#ffffff 78%);',
    'z-index:9997;pointer-events:none;',
    'opacity:1;',
    'transition:opacity 520ms ease-out;',
    '}',
    'html.walkthrough-loaded body::before{opacity:0;}',
    'html[data-walkthrough-transition="fading-out"] body::before{',
    'opacity:1;transition:opacity 220ms ease-in;',
    '}',
    // The target highlight ring, click ripple and cursor are drawn by the
    // recorder as overlays (generate-walkthrough/scripts/interaction_fx.js),
    // never as styles on the mockup's own elements.
    // ── Title-card layout ─────────────────────────────────────────────
    // Cards come in a light and a dark theme, picked per project by the
    // logo's ink luminance (dark logo -> light card and vice versa, see
    // writeTitleCards). When a card_bg image is present it covers the
    // flat theme background, so the theme instead follows the image's
    // measured luminance, and a logo whose ink would blend into the image
    // gets a contrast plate (.walkthrough-card-logo--plate-*). Both themes
    // layer soft brand-tinted radial glows and a faint dot grid over a
    // flat base so the card has depth without AI background art.
    // --walkthrough-card-font carries the project's first Google Font when
    // branding provides one.
    // position:relative + overflow:hidden lets the (optional) bg div fill
    // the viewport while still allowing transform:scale to grow past the
    // natural edges without leaking outside the frame.
    'body[data-walkthrough-card]{',
    'margin:0;width:100vw;height:100vh;min-height:100vh;',
    'display:flex;align-items:center;justify-content:center;',
    'background-image:',
    'radial-gradient(color-mix(in srgb,var(--brand-primary,#64748b) 14%,transparent) 1px,transparent 1.5px),',
    'radial-gradient(56rem 38rem at 14% 18%,color-mix(in srgb,var(--brand-primary,#6366f1) 16%,transparent),transparent 70%),',
    'radial-gradient(64rem 44rem at 86% 84%,color-mix(in srgb,var(--brand-accent,var(--brand-primary,#6366f1)) 12%,transparent),transparent 70%);',
    'background-size:26px 26px,auto,auto;',
    'background-color:#fff;',
    "font-family:var(--walkthrough-card-font,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif);",
    'color:#0f172a;',
    'position:relative;overflow:hidden;',
    '}',
    'body[data-walkthrough-card][data-card-theme="dark"]{',
    'background-image:',
    'radial-gradient(rgba(255,255,255,0.07) 1px,transparent 1.5px),',
    'radial-gradient(56rem 38rem at 14% 18%,color-mix(in srgb,var(--brand-primary,#6366f1) 34%,transparent),transparent 70%),',
    'radial-gradient(64rem 44rem at 86% 84%,color-mix(in srgb,var(--brand-accent,var(--brand-primary,#6366f1)) 22%,transparent),transparent 70%);',
    'background-size:26px 26px,auto,auto;',
    'background-color:#0b1120;',
    'color:#fff;',
    '}',
    'body[data-walkthrough-card] .walkthrough-card-bg{',
    'position:absolute;inset:0;',
    'background-size:cover;background-position:center;background-repeat:no-repeat;',
    'z-index:0;transform-origin:center center;',
    // Animation: slow zoom from 1.0 to 1.06 over 6s. Ease-out so most of
    // the motion happens in the first 2s while the eye is still settling
    // on the card. forwards keeps the final scale stuck so the card
    // doesn't snap back on long holds.
    'animation:walkthrough-card-kenburns 6000ms ease-out 0ms forwards;',
    'will-change:transform;',
    '}',
    'body[data-walkthrough-card] .walkthrough-card{',
    'text-align:center;max-width:80%;padding:0 24px;',
    'position:relative;z-index:1;',
    '}',
    'body[data-walkthrough-card] .walkthrough-card-logo{',
    'max-height:84px;max-width:260px;margin:0 auto 28px;',
    'object-fit:contain;display:block;',
    // Entrance: scale 0.92 -> 1.0 + opacity 0 -> 1 over 800ms starting
    // at 200ms after the card mounts. Cubic-bezier matches the brand
    // polish used elsewhere (data-walkthrough-stage zoom curve).
    'opacity:0;transform:scale(0.92);',
    'animation:walkthrough-card-logo-in 800ms cubic-bezier(0.2,0.8,0.2,1) 200ms forwards;',
    'will-change:opacity,transform;',
    '}',
    // Contrast plate behind the logo, applied by writeTitleCards when the
    // logo's ink luminance sits too close to the card_bg image behind it
    // (green logo on a green gradient). The image shows through the logo's
    // transparent pixels, so the plate is just padding + a translucent fill
    // on the <img> itself. content-box keeps the 84px cap on the artwork
    // even when project CSS resets everything to border-box.
    'body[data-walkthrough-card] .walkthrough-card-logo--plate-light,',
    'body[data-walkthrough-card] .walkthrough-card-logo--plate-dark{',
    'box-sizing:content-box;padding:16px 26px;border-radius:18px;',
    '}',
    'body[data-walkthrough-card] .walkthrough-card-logo--plate-light{',
    'background:rgba(255,255,255,0.92);',
    'box-shadow:0 10px 34px rgba(2,6,23,0.22);',
    '}',
    'body[data-walkthrough-card] .walkthrough-card-logo--plate-dark{',
    'background:rgba(11,17,32,0.80);',
    'box-shadow:0 10px 34px rgba(2,6,23,0.35);',
    '}',
    // Explicit colour on title + tagline so project-injected CSS
    // (e.g. Bootstrap `h1 { color: ... }`) can't override via direct
    // type-selector specificity. Body's inherited colour loses to a direct
    // h1 colour declaration; setting it here at (0,2,1) specificity wins.
    'body[data-walkthrough-card] .walkthrough-card-title{',
    'color:#0f172a;',
    'font-size:48px;font-weight:700;margin:0 0 16px;',
    'letter-spacing:-0.02em;line-height:1.1;',
    '}',
    'body[data-walkthrough-card][data-card-theme="dark"] .walkthrough-card-title{',
    'color:#fff;',
    '}',
    // Title text is wrapped in an inline-block span so clip-path can mask
    // it left-to-right without disrupting the surrounding block layout.
    // The wrapper span animates inset clipping; the h1 itself stays clean.
    'body[data-walkthrough-card] .walkthrough-card-title-text{',
    'display:inline-block;',
    'clip-path:inset(0 100% 0 0);',
    'animation:walkthrough-card-title-mask 800ms cubic-bezier(0.2,0.8,0.2,1) 500ms forwards;',
    'will-change:clip-path;',
    '}',
    'body[data-walkthrough-card] .walkthrough-card-tagline{',
    'color:#334155;',
    'font-size:20px;opacity:0.9;margin:0;font-weight:400;line-height:1.4;',
    // Override: start at 0 opacity + 12px down, animate up. The 0.9
    // baseline opacity becomes the animation target via to{opacity:0.9}
    // in the keyframes, keeping the subtle text fade after entrance.
    'opacity:0;transform:translateY(12px);',
    'animation:walkthrough-card-tagline-in 500ms cubic-bezier(0.2,0.8,0.2,1) 1000ms forwards;',
    'will-change:opacity,transform;',
    '}',
    'body[data-walkthrough-card][data-card-theme="dark"] .walkthrough-card-tagline{',
    'color:#cbd5e1;',
    '}',
    // When a bg image is present (the sibling .walkthrough-card-bg div only
    // exists then), give the title/tagline a soft counter-shadow so
    // mid-luminance gradients can't wash the text out; the theme flip in
    // writeTitleCards already handles the clear-cut light/dark cases.
    'body[data-walkthrough-card] .walkthrough-card-bg~.walkthrough-card .walkthrough-card-title,',
    'body[data-walkthrough-card] .walkthrough-card-bg~.walkthrough-card .walkthrough-card-tagline{',
    'text-shadow:0 1px 2px rgba(255,255,255,0.55),0 0 26px rgba(255,255,255,0.45);',
    '}',
    'body[data-walkthrough-card][data-card-theme="dark"] .walkthrough-card-bg~.walkthrough-card .walkthrough-card-title,',
    'body[data-walkthrough-card][data-card-theme="dark"] .walkthrough-card-bg~.walkthrough-card .walkthrough-card-tagline{',
    'text-shadow:0 1px 2px rgba(2,6,23,0.60),0 0 26px rgba(2,6,23,0.50);',
    '}',
    // Outro fade-to-black: the recorder sets data-walkthrough-fade-out=1
    // ~400ms before stopping recording. A black overlay fades IN over the
    // card (rather than fading the body out, which would flash the white
    // html background on dark cards), producing a clean tail on both themes.
    'body[data-walkthrough-card="outro"]::after{',
    "content:'';position:fixed;top:0;left:0;right:0;bottom:0;",
    'background:#000;opacity:0;pointer-events:none;z-index:9998;',
    '}',
    'body[data-walkthrough-card="outro"][data-walkthrough-fade-out="1"]::after{',
    'animation:walkthrough-card-fade-out 400ms ease-in 0ms forwards;',
    '}',
    '@keyframes walkthrough-card-kenburns{',
    '0%{transform:scale(1);}',
    '100%{transform:scale(1.06);}',
    '}',
    '@keyframes walkthrough-card-logo-in{',
    '0%{opacity:0;transform:scale(0.92);}',
    '100%{opacity:1;transform:scale(1);}',
    '}',
    '@keyframes walkthrough-card-title-mask{',
    '0%{clip-path:inset(0 100% 0 0);}',
    '100%{clip-path:inset(0 0% 0 0);}',
    '}',
    '@keyframes walkthrough-card-tagline-in{',
    '0%{opacity:0;transform:translateY(12px);}',
    '100%{opacity:0.9;transform:translateY(0);}',
    '}',
    '@keyframes walkthrough-card-fade-out{',
    '0%{opacity:0;}',
    '100%{opacity:1;}',
    '}',
    // ── Radial-wipe transition into step_0 ────────────────────────────
    // When the recorder navigates from the intro card to step_0, the new
    // page carries data-walkthrough-wipe-in=1 on its body. The stage
    // wrapper (data-walkthrough-stage) gets a clip-path that expands from
    // a centred dot to a full-viewport circle over 700ms — the brand-wash
    // overlay underneath fades on the existing schedule, so the user sees
    // the brand wash dissolve as the mockup emerges through an expanding
    // circle. Only step_0 carries this attribute; step-to-step transitions
    // keep the existing cross-fade.
    'body[data-walkthrough-wipe-in="1"] [data-walkthrough-stage]{',
    'clip-path:circle(0% at 50% 50%);',
    'animation:walkthrough-stage-wipe-in 700ms cubic-bezier(0.2,0.8,0.2,1) 0ms forwards;',
    'will-change:clip-path;',
    '}',
    '@keyframes walkthrough-stage-wipe-in{',
    '0%{clip-path:circle(0% at 50% 50%);}',
    '100%{clip-path:circle(150% at 50% 50%);}',
    '}',
    '</style>',
].join('');

// Tiny inline loader that triggers the cross-fade fade-in once the document is
// parsed. Without this the body::before overlay stays opaque (default state)
// and the page would never become visible. Placed in <head> so it runs as
// early as possible — the readyState check covers the case where the script
// parses after DOMContentLoaded already fired (rare, but possible when
// scripts above it block).
const WALKTHROUGH_LOADER = [
    '<script data-walkthrough-loader="1">',
    "(function(){var g=function(){document.documentElement.classList.add('walkthrough-loaded');};",
    "if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',g);}else{g();}})();",
    '</script>',
].join('');

// Stage wrapper around mockup content. The recorder controls its transform to
// zoom in on interactions (clicks, typing fields). The ghost-cursor element is
// NOT inside the stage — it's a direct child of body — so it stays stable while
// the stage scales. Keeping transform-origin at 0 0 means the recorder fully
// controls the focal point via inline style updates.
const STAGE_OPEN = [
    '<div data-walkthrough-stage="1" style="',
    'display:block;',
    // min-height ensures the stage fills the visible viewport even when the
    // mockup content is short — without it, a 200px-tall card on an otherwise
    // empty page would leave ~500px of blank body background at the bottom of
    // the 720p video. The mockup owns the full 720px frame (no caption
    // chrome is reserved), so the content box is exactly the viewport height.
    'min-height:100vh;',
    'transform:scale(1);',
    'transform-origin:0 0;',
    'transition:transform 350ms cubic-bezier(0.4,0,0.2,1);',
    // No will-change here: it pins the stage's raster at scale 1, so text
    // blurs when the camera zooms in. transform:scale(1) alone keeps the
    // stage the containing block the root-offset bridge relies on.
    '">',
].join('');
const STAGE_CLOSE = '</div>';

// ─── Small helpers ───────────────────────────────────────────────────────────

const log = message => process.stderr.write(message + '\n');

/** Truthiness as the branding/manifest checks expect: empty objects and arrays are false. */
function truthy(value) {
    if (Array.isArray(value)) return value.length > 0;
    if (value !== null && typeof value === 'object') return Object.keys(value).length > 0;
    return Boolean(value);
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Replace every occurrence of a literal string (no `$` pattern handling). */
function replaceAllLiteral(text, search, replacement) {
    return text.split(search).join(replacement);
}

/** Replace the first occurrence of a literal string (no `$` pattern handling). */
function replaceFirstLiteral(text, search, replacement) {
    const at = text.indexOf(search);
    return at < 0 ? text : text.slice(0, at) + replacement + text.slice(at + search.length);
}

function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isFile(file) {
    try { return fs.statSync(file).isFile(); } catch { return false; }
}

function isDir(dir) {
    try { return fs.statSync(dir).isDirectory(); } catch { return false; }
}

function readFileOrEmpty(file) {
    try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Split a directory into subdirectories and files; symlinked directories are listed but never followed. */
function listDir(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return { dirs: [], files: [] }; }
    const dirs = [];
    const files = [];
    for (const entry of entries) {
        let directory = entry.isDirectory();
        if (entry.isSymbolicLink()) {
            try { directory = fs.statSync(path.join(dir, entry.name)).isDirectory(); } catch { directory = false; }
            if (directory) continue;
        }
        (directory ? dirs : files).push(entry.name);
    }
    return { dirs, files };
}

// ─── Inputs ──────────────────────────────────────────────────────────────────

function loadCss(cssFile) {
    if (!cssFile || !isFile(cssFile)) return null;
    try {
        const content = fs.readFileSync(cssFile, 'utf8').trim();
        return content || null;
    } catch { return null; }
}

function loadImages(imagesJson) {
    if (!isFile(imagesJson)) return {};
    try { return readJson(imagesJson).images ?? {}; } catch { return {}; }
}

/**
 * Load generated_images.json and return id -> data URI.
 *
 * Generated files deliberately stay separate from the project image manifest:
 * .rtfm/images_base64.json is signature-cached from repository assets, while
 * generated content is output-scoped and cacheable independently.
 */
function loadGeneratedImages(generatedImagesJson) {
    if (!generatedImagesJson) return {};
    if (!isFile(generatedImagesJson)) {
        log(`WARNING: generated image manifest not found: ${generatedImagesJson}`);
        return {};
    }
    let manifest;
    try { manifest = readJson(generatedImagesJson); }
    catch (error) {
        log(`WARNING: cannot read generated image manifest: ${error.message}`);
        return {};
    }

    const resolved = {};
    const baseDir = path.dirname(path.resolve(generatedImagesJson));
    const assets = truthy(manifest?.assets) && isObject(manifest.assets) ? manifest.assets : {};
    for (const [assetId, entry] of Object.entries(assets)) {
        if (!isObject(entry)) continue;
        const relPath = entry.path;
        if (typeof relPath !== 'string') continue;
        const assetPath = path.resolve(baseDir, relPath);
        const inside = assetPath === baseDir || assetPath.startsWith(baseDir + path.sep);
        if (!inside || !isFile(assetPath)) {
            log(`WARNING: generated asset '${assetId}' is missing or outside its output directory`);
            continue;
        }
        let encoded;
        try { encoded = fs.readFileSync(assetPath).toString('base64'); }
        catch (error) {
            log(`WARNING: cannot read generated asset '${assetId}': ${error.message}`);
            continue;
        }
        const mime = entry.mime || (assetPath.endsWith('.svg') ? 'image/svg+xml' : 'image/png');
        resolved[assetId] = `data:${mime};base64,${encoded}`;
    }
    return resolved;
}

/**
 * Load actions.json steps and merge in matching content from article.json
 * (located next to actions.json) so the title cards can read the article
 * title / introduction / summary at inject time, and the step count is known.
 * Returns { steps, article } or null.
 */
function loadWalkthroughSteps(actionsJson) {
    if (!actionsJson) return null;
    if (!isFile(actionsJson)) {
        log(`WARNING: --walkthrough file not found: ${actionsJson}`);
        return null;
    }
    let data;
    try { data = readJson(actionsJson); }
    catch (error) {
        log(`WARNING: failed to read ${actionsJson}: ${error.message}`);
        return null;
    }

    const steps = truthy(data.steps) ? data.steps : [];

    // Try to read article.json from the same directory so we can attach
    // per-step content + article-level title/intro/summary for title cards.
    let article = {};
    const articlePath = path.join(path.dirname(actionsJson) || '.', 'article.json');
    if (isFile(articlePath)) {
        try { article = readJson(articlePath) || {}; }
        catch (error) { log(`WARNING: failed to read ${articlePath}: ${error.message}`); }
    }

    const articleSteps = truthy(article.steps) ? article.steps : [];
    const merged = steps.map((step, i) => {
        const mergedStep = { ...step };
        if (i < articleSteps.length && isObject(articleSteps[i])) {
            for (const key of ['title', 'content']) {
                if (!truthy(mergedStep[key]) && truthy(articleSteps[i][key])) mergedStep[key] = articleSteps[i][key];
            }
        }
        return mergedStep;
    });

    return {
        steps: merged,
        article: { title: article.title, introduction: article.introduction, summary: article.summary },
    };
}

// ─── CSS asset inlining ──────────────────────────────────────────────────────
// Compiled app CSS often references repo assets by relative url() — e.g.
// .block-pattern-green { background-image: url('img/block-pattern-green.png') }.
// Those paths can never resolve from a file:// mockup, so the styled region
// renders blank and the authoring model "fills in" the missing visual with an
// invented gradient. Inline them as data URIs so the real asset renders.

const CSS_ASSET_MAX_BYTES = 1_500_000;
const CSS_ASSET_MIME = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
    '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
};
const ASSET_WALK_SKIP_DIRS = new Set(['node_modules', 'tmp', 'log', 'output', 'coverage', 'dist', 'build']);

const CSS_URL_RE = /url\(\s*(['"]?)([^)'"]+)\1\s*\)/g;

/** One walk of the project tree resolving wanted basenames → absolute paths. */
function findProjectAssets(projectDir, basenames) {
    const wanted = new Set([...basenames].map(name => name.toLowerCase()));
    const found = {};
    const visit = dir => {
        const { dirs, files } = listDir(dir);
        for (const file of files) {
            const low = file.toLowerCase();
            if (wanted.has(low) && !(low in found)) found[low] = path.join(dir, file);
        }
        if (Object.keys(found).length === wanted.size) return true;
        for (const name of dirs) {
            if (ASSET_WALK_SKIP_DIRS.has(name) || name.startsWith('.')) continue;
            if (visit(path.join(dir, name))) return true;
        }
        return false;
    };
    visit(projectDir);
    return found;
}

/**
 * Rewrite relative url() refs in cssPath to data URIs (matched by basename
 * anywhere in the project tree). Idempotent — data:/http(s) refs are skipped.
 * Returns the number of refs inlined.
 */
function inlineCssAssetUrls(cssPath, projectDir) {
    let css;
    try { css = fs.readFileSync(cssPath, 'utf8'); } catch { return 0; }

    const refs = new Map();
    for (const match of css.matchAll(CSS_URL_RE)) {
        const target = match[2].trim();
        if (['data:', 'http://', 'https://', '//', '#'].some(prefix => target.startsWith(prefix))) continue;
        const base = path.posix.basename(target.split('?')[0].split('#')[0]);
        const ext = path.extname(base).toLowerCase();
        if (Object.hasOwn(CSS_ASSET_MIME, ext)) refs.set(match[0], { base, ext });
    }
    if (!refs.size) return 0;

    const lookup = findProjectAssets(projectDir, new Set([...refs.values()].map(ref => ref.base)));
    const replacements = new Map();
    for (const [raw, { base, ext }] of refs) {
        const file = lookup[base.toLowerCase()];
        if (!file) continue;
        let data;
        try {
            const size = fs.statSync(file).size;
            if (!(size > 0 && size <= CSS_ASSET_MAX_BYTES)) continue;
            data = fs.readFileSync(file).toString('base64');
        } catch { continue; }
        replacements.set(raw, `url(data:${CSS_ASSET_MIME[ext]};base64,${data})`);
    }

    if (!replacements.size) return 0;
    for (const [raw, replacement] of replacements) css = replaceAllLiteral(css, raw, replacement);
    fs.writeFileSync(cssPath, css);
    return replacements.size;
}

// ─── Icon font embedding ─────────────────────────────────────────────────────
// Icon fonts usually arrive via an app bundle or CDN, neither of which exists
// in a self-contained mockup (renders block external requests). When step HTML
// uses fa-*/bi-* classes, fetch the icon CSS once, inline its woff2 fonts as
// data URIs, and cache the result in the project cache dir so later runs skip
// the fetch.

const ICON_FONT_SOURCES = {
    fontawesome: {
        detect: /class=["'][^"']*\bfa[srlbd]?\s+fa-|class=["'][^"']*\bfa-[a-z]/,
        cssUrl: 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css',
    },
    'bootstrap-icons': {
        detect: /class=["'][^"']*\bbi[\s-]/,
        cssUrl: 'https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css',
    },
    'material-icons': {
        // Ligature-based: <span class="material-icons">home</span>
        detect: /class=["'][^"']*\bmaterial-icons/,
        cssUrl: 'https://fonts.googleapis.com/icon?family=Material+Icons',
    },
    'material-symbols': {
        // <span class="material-symbols-outlined">home</span> (+rounded/sharp)
        detect: /class=["'][^"']*\bmaterial-symbols-/,
        cssUrl: 'https://fonts.googleapis.com/css2'
            + '?family=Material+Symbols+Outlined'
            + '&family=Material+Symbols+Rounded'
            + '&family=Material+Symbols+Sharp',
    },
    boxicons: {
        // <i class="bx bx-home">, bxs- (solid), bxl- (logos)
        detect: /class=["'][^"']*\bbx\s+bx[sl]?-/,
        cssUrl: 'https://cdn.jsdelivr.net/npm/boxicons@2.1.4/css/boxicons.min.css',
    },
    remixicon: {
        // <i class="ri-home-line">
        detect: /class=["'][^"']*\bri-[a-z0-9-]+/,
        cssUrl: 'https://cdn.jsdelivr.net/npm/remixicon@4.2.0/fonts/remixicon.css',
    },
    glyphicons: {
        // Bootstrap 3 legacy: <span class="glyphicon glyphicon-cog">. Only
        // ships inside the full BS3 stylesheet, so filter to glyphicon rules —
        // injecting all of Bootstrap 3 would clobber the project's real CSS.
        detect: /class=["'][^"']*\bglyphicon\b/,
        cssUrl: 'https://cdn.jsdelivr.net/npm/bootstrap@3.4.1/dist/css/bootstrap.min.css',
        selectorFilter: 'glyphicon',
    },
};

const ICON_FONTS_FILENAME = 'icon_fonts.css';

async function fetchBytes(url, timeoutMs = 20000) {
    // Browser UA: Google Fonts sniffs the UA and only serves woff2 (and the
    // ligature-capable CSS) to modern browsers — an unknown agent gets ttf.
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
        + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
    const response = await fetch(url, { headers: { 'User-Agent': ua }, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`HTTP Error ${response.status}: ${response.statusText}`);
    return Buffer.from(await response.arrayBuffer());
}

/**
 * Keep only @font-face blocks and rules whose selector mentions the
 * substring. Good enough for minified framework CSS — used to extract the
 * glyphicon subset from Bootstrap 3 without importing its layout rules.
 */
function filterCssRules(css, selectorSubstring) {
    const kept = [];
    for (const match of css.matchAll(/(@font-face\s*\{[^{}]*\})|([^{}@]+)\{([^{}]*)\}/g)) {
        if (match[1]) kept.push(match[1]);
        else if ((match[2] ?? '').includes(selectorSubstring)) kept.push(`${match[2].trim()}{${match[3]}}`);
    }
    return kept.join('\n');
}

/**
 * Fetch an icon CSS file and inline its woff2 fonts as data URIs. Other
 * font formats are rewritten to absolute URLs (blocked at render time, but
 * woff2 comes first in every src list so Chromium never needs them).
 */
async function fetchIconCssWithFonts(cssUrl, selectorFilter) {
    let css = (await fetchBytes(cssUrl)).toString('utf8');
    if (selectorFilter) css = filterCssRules(css, selectorFilter);

    const replacements = [];
    for (const match of css.matchAll(CSS_URL_RE)) {
        const target = match[2].trim();
        if (target.startsWith('data:')) {
            replacements.push(match[0]);
            continue;
        }
        const absolute = new URL(target, cssUrl).href;
        if (target.split('?')[0].split('#')[0].endsWith('.woff2')) {
            try {
                replacements.push(`url(data:font/woff2;base64,${(await fetchBytes(absolute)).toString('base64')})`);
            } catch {
                replacements.push(`url(${absolute})`);
            }
        } else {
            replacements.push(`url(${absolute})`);
        }
    }
    let i = 0;
    return css.replace(CSS_URL_RE, () => replacements[i++]);
}

/**
 * Detect icon-font usage across article/walkthrough mockups; build/reuse a cached
 * icon_fonts.css with embedded fonts. Returns the local filename to link
 * from the head block, or null when no icon classes are present.
 */
async function ensureIconFonts(htmlDir, cacheDir) {
    let combined = '';
    for (const fname of fs.readdirSync(htmlDir)) {
        if ((fname.startsWith('step_') || fname.startsWith('block_')) && fname.endsWith('.html')) {
            try { combined += fs.readFileSync(path.join(htmlDir, fname), 'utf8'); } catch { /* skip */ }
        }
    }
    const needed = Object.entries(ICON_FONT_SOURCES).filter(([, spec]) => spec.detect.test(combined)).map(([name]) => name);
    if (!needed.length) return null;

    const cachePath = cacheDir ? path.join(cacheDir, ICON_FONTS_FILENAME) : null;
    let existing = cachePath && isFile(cachePath) ? readFileOrEmpty(cachePath) : '';
    const have = new Set([...existing.matchAll(/\/\* rtfm-icon-set: (\S+) \*\//g)].map(match => match[1]));

    for (const name of needed.filter(name => !have.has(name)).sort()) {
        try {
            const spec = ICON_FONT_SOURCES[name];
            const css = await fetchIconCssWithFonts(spec.cssUrl, spec.selectorFilter);
            existing += `\n/* rtfm-icon-set: ${name} */\n${css}`;
            log(`  embedded icon font set: ${name}`);
        } catch (error) {
            log(`WARNING: could not fetch icon font set ${name}: ${error.message} (renderer glyph fallback will be used)`);
        }
    }

    if (!existing.trim()) return null;
    if (cachePath) {
        try { fs.writeFileSync(cachePath, existing); } catch { /* cache is optional */ }
    }
    fs.writeFileSync(path.join(htmlDir, ICON_FONTS_FILENAME), existing);
    return ICON_FONTS_FILENAME;
}

/** Load branding.json. Returns null if missing, unreadable, or empty {}. */
function loadBranding(brandingJson) {
    if (!brandingJson || !isFile(brandingJson)) return null;
    try {
        const data = readJson(brandingJson);
        return truthy(data) ? data : null;
    } catch (error) {
        log(`WARNING: failed to read ${brandingJson}: ${error.message}`);
        return null;
    }
}

/**
 * Extract the first font family name from branding.google_fonts entries,
 * e.g. https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap
 * -> "Inter". Descriptor objects contribute their `family`. Used to put the
 * brand font on the intro/outro title cards. Returns null when none parses.
 */
function firstGoogleFontFamily(branding) {
    for (const item of (truthy(branding?.google_fonts) ? branding.google_fonts : [])) {
        let family = null;
        if (typeof item === 'string') {
            const match = item.match(/[?&]family=([^:&]+)/);
            if (match) family = match[1].replaceAll('+', ' ').replaceAll('%20', ' ').trim();
        } else if (isObject(item) && typeof item.family === 'string') {
            family = item.family.trim();
        }
        if (family) return family.replaceAll("'", '');
    }
    return null;
}

/**
 * Normalise a google_fonts entry to a fonts.googleapis.com CSS URL.
 *
 * Accepts either a plain URL string (used verbatim) or a descriptor object like
 * {"family": "Plus Jakarta Sans", "weights": ["500","600","700"], "source": ...}
 * (what detect-project records for a next/font/google import), which is turned
 * into https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@500;600;700&display=swap.
 * Returns null for anything unusable.
 */
function fontDescriptorToUrl(item) {
    if (typeof item === 'string') {
        const s = item.trim();
        if (!s) return null;
        // A bare family name ("Inter") is not a URL — emitting it verbatim as an
        // href produces a broken <link href="Inter"> tag. Compose the css2 URL.
        if (!/^(https?:)?\/\//.test(s) && !s.includes('/')) {
            return `https://fonts.googleapis.com/css2?family=${s.replaceAll(' ', '+')}&display=swap`;
        }
        return s;
    }
    if (isObject(item)) {
        const family = String(item.family || '').trim();
        if (!family) return null;
        const famQ = family.replaceAll(' ', '+');
        const weights = (truthy(item.weights) ? item.weights : []).map(w => String(w).trim()).filter(Boolean);
        if (weights.length) return `https://fonts.googleapis.com/css2?family=${famQ}:wght@${weights.join(';')}&display=swap`;
        return `https://fonts.googleapis.com/css2?family=${famQ}&display=swap`;
    }
    return null;
}

const BODY_SELECTOR_RE = /^(?:html\s+)?body((?:[.:#[][^\s>+~,{]*)*)$/;
const BG_DECL_RE = /(?:^|;)\s*(background(?:-color|-image)?\s*:[^;]+)/gi;

/**
 * Bridge body-scoped backgrounds into the desktop window interior.
 *
 * Real apps paint their canvas on `body` (often gated by a theme class:
 * `body.theme-dark { background: … }`). Inside a framed desktop mockup the
 * app lives in `.desktop-window-content`, and `body` is the surrounding
 * stage — so those backgrounds never reach the window interior and a themed
 * app renders on the frame's default white (dark-theme text becomes
 * white-on-white "voids"). Re-emit every body-targeting background rule
 * against `.desktop-window-content`, preserving the original body selector
 * prefix so theme-class gating still applies.
 */
function desktopWindowBgBridge(cssText) {
    if (!cssText) return '';
    const bridged = [];
    for (const match of cssText.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const [, rawSel, body] = match;
        if (!body.includes('background')) continue;
        for (let sel of rawSel.split(',')) {
            sel = sel.trim().split('}').at(-1).trim(); // drop leading at-rule tails
            const sm = sel.match(BODY_SELECTOR_RE);
            if (!sm) continue;
            const decls = [...body.matchAll(BG_DECL_RE)].map(m => m[1].trim().replace(/;+$/, ''));
            if (!decls.length) continue;
            const suffix = sm[1] || '';
            bridged.push(`body${suffix} .desktop-window-content { ${decls.join('; ')}; }`);
            // Modal surfaces get the same app canvas colour — an app's own modal
            // CSS is often JS-injected/unbuilt, and a transparent dialog with the
            // page bleeding through is worse than a flat canvas-coloured card.
            bridged.push(`body${suffix} .desktop-modal { ${decls.join('; ')}; }`);
        }
    }
    if (!bridged.length) return '';
    return '/* window-bg bridge: body-scoped app backgrounds re-emitted onto the\n'
        + '   framed window interior (generated by inject_assets.js) */\n' + bridged.join('\n');
}

const TRIVIAL_OFFSET_RE = /^(?:0(?:\.0+)?(?:px|rem|em|%|vh|vw)?|[12](?:\.\d+)?px|initial|unset|inherit|revert|auto)$/i;

/**
 * Bridge root-level fixed-chrome offsets into the walkthrough stage.
 *
 * The zoom stage carries `transform: scale(1)`, which makes it
 * the CONTAINING BLOCK for position:fixed descendants (CSS spec) — so an app's
 * fixed top bar anchors to the stage box instead of the viewport. Meanwhile
 * the offset that keeps that bar off the content lives on the ROOT elements
 * (`html.wp-toolbar { padding-top: 32px }`, Bootstrap's body padding), which
 * sit OUTSIDE the stage: the stage is pushed down by the offset, the captured
 * bar renders at the stage's top edge, and the bar overlaps the first slice
 * of content with an empty band above it. Articles have no stage and are
 * immune — this is walkthrough-only geometry.
 *
 * Fix: replicate the viewport geometry inside the stage. Zero each matching
 * root-level offset and give [data-walkthrough-stage] the same padding-top,
 * so the captured bar paints in the stage's padding band exactly where the
 * real page paints it, and zooming scales bar + content coherently. Only
 * offsets whose selector class is actually present on this step's <html>/
 * <body> are bridged; var() expressions are kept verbatim (they resolve in
 * the document). Returns '' when the step has no such offsets — the common
 * case, leaving output byte-identical.
 */
function fixedOffsetBridgeCss(html, cssText) {
    if (!html || !cssText) return '';
    const tokens = {};
    for (const root of ['html', 'body']) {
        const match = html.match(new RegExp(`<${root}[^>]*\\bclass\\s*=\\s*"([^"]*)"`, 'i'));
        tokens[root] = new Set((match ? match[1] : '').split(/\s+/).filter(Boolean));
    }
    if (!tokens.html.size && !tokens.body.size) return '';
    const offsets = new Map(); // "root.cls" -> first non-trivial padding-top expression
    for (const match of cssText.matchAll(/([^{};]+)\{([^{}]*)\}/g)) {
        const [, sel, decls] = match;
        const pt = decls.match(/(?:^|;)\s*padding-top\s*:\s*([^;]+)/i);
        if (!pt) continue;
        const value = pt[1].replaceAll('!important', '').trim();
        if (TRIVIAL_OFFSET_RE.test(value)) continue;
        for (const sm of sel.matchAll(/(?:^|[,\s])(html|body)\.([A-Za-z0-9_-]+)/g)) {
            const [, root, cls] = sm;
            if (tokens[root].has(cls) && !offsets.has(`${root}.${cls}`)) offsets.set(`${root}.${cls}`, value);
        }
    }
    if (!offsets.size) return '';
    const zeroRules = [...offsets.keys()].map(key => `${key}{padding-top:0 !important;}`).join('');
    const exprs = [...new Set(offsets.values())];
    const total = exprs.length === 1 ? exprs[0] : 'calc(' + exprs.join(' + ') + ')';
    return '<style data-rtfm-offset-bridge="1">'
        + '/* root-offset bridge: the zoom stage captures position:fixed, so the '
        + 'root-level chrome offset is re-applied inside the stage */'
        + `${zeroRules}[data-walkthrough-stage]{padding-top:${total};}`
        + '</style>';
}

/**
 * Build the HTML snippet that replaces <!-- INJECT_CSS --> in each mockup.
 *
 * Without branding: <style> if cssContent is given, else bare Tailwind CDN.
 * With branding, layers in compiled CSS / framework CDN / Google Fonts /
 * external stylesheets / :root vars in the documented order.
 *
 * Tailwind projects always get the CDN even when compiled_css_path is set.
 * The compiled build is purged — it only contains classes present in the real
 * project templates. Mockup markup often uses additional utility classes that
 * were never in the source, so the CDN is needed as a complete-coverage
 * companion. The compiled CSS loads first so its component/override rules still
 * take precedence over CDN-generated utilities. A local JIT mockup.css, when
 * present, replaces the Play CDN (reliable + offline).
 */
function buildCssHeadBlock(cssContent, branding, { jitCss = null, twHint = false, extraCss = null } = {}) {
    if (!branding) return cssContent ? `<style>\n${cssContent}\n</style>` : TAILWIND_CDN;

    const parts = [];
    const framework = String(branding.framework || '').toLowerCase();
    const compiledCssPath = branding.compiled_css_path;
    const frameworkCdn = branding.framework_cdn;
    const isTailwindFamily = framework.includes('tailwind') || ['', 'none', 'custom'].includes(framework) || twHint;

    // 1. Compiled CSS first (highest fidelity — same bytes the app actually serves)
    if (truthy(compiledCssPath)) parts.push(`<link rel="stylesheet" href="${compiledCssPath}">`);

    // 1b. Render-time JIT CSS (mockup.css) — locally compiled from THIS mockup's
    //     markup via the project's cached Tailwind recipe, so it contains exactly
    //     the classes the mockup uses (arbitrary values, responsive variants, plugin
    //     classes). When present it *replaces* the Play CDN below — reliable + local,
    //     no network dependency in the headless render.
    if (jitCss) parts.push(`<link rel="stylesheet" href="${jitCss}">`);

    // 2. Tailwind runtime config override (must precede any Tailwind CDN <script>).
    //    Only configures the CDN, so skip it entirely when JIT CSS covers the classes.
    if (framework.includes('tailwind') && truthy(branding.tailwind_extend_raw) && !jitCss) {
        const extend = replaceAllLiteral(String(branding.tailwind_extend_raw), '</script>', '<\\/script>');
        parts.push(`<script>window.tailwind=window.tailwind||{};window.tailwind.config={theme:{extend:${extend}}};</script>`);
    }

    // 3. Framework CDN.
    //    Non-Tailwind: skip when compiled CSS is present (CDN would duplicate coverage).
    //    Tailwind: inject alongside the (purged) compiled CSS — UNLESS JIT CSS is present.
    if (truthy(frameworkCdn) && (!truthy(compiledCssPath) || framework.includes('tailwind')) && !jitCss) {
        if (String(frameworkCdn).endsWith('.css')) parts.push(`<link rel="stylesheet" href="${frameworkCdn}">`);
        else parts.push(`<script src="${frameworkCdn}"></script>`); // Tailwind's CDN is a JS bundle
    }

    // 4. Tailwind CDN fallback — fires when no framework_cdn is in branding.json.
    //    Skipped when JIT CSS is present (it already carries the mockup's classes).
    if (isTailwindFamily && !truthy(frameworkCdn) && !jitCss) {
        if (cssContent && !truthy(compiledCssPath)) parts.push(`<style>\n${cssContent}\n</style>`);
        else parts.push(TAILWIND_CDN);
    }

    // 5. Google Fonts. detect-project may record these either as a plain CSS URL
    // string OR as a structured descriptor object ({"family","weights","source"} —
    // e.g. a next/font/google import). Build a real fonts.googleapis.com URL from
    // the object; stringifying it straight into href yields a broken link that
    // 404s (leaving the mockup on a system-font fallback).
    for (const item of (truthy(branding.google_fonts) ? branding.google_fonts : [])) {
        const url = fontDescriptorToUrl(item);
        if (url) parts.push(`<link rel="stylesheet" href="${url}">`);
    }

    // 6. External stylesheets (tippy, highlight.js, etc.)
    for (const url of (truthy(branding.external_stylesheets) ? branding.external_stylesheets : [])) {
        parts.push(`<link rel="stylesheet" href="${url}">`);
    }

    // 7. :root vars + design tokens + var overrides
    const styleBlocks = [];
    const rootLines = [];
    if (truthy(branding.root_css)) rootLines.push(branding.root_css);
    const cardFont = firstGoogleFontFamily(branding);
    if (cardFont) rootLines.push(`  --walkthrough-card-font: '${cardFont}', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;`);
    if (truthy(branding.default_colors)) {
        for (const [k, v] of Object.entries(branding.default_colors)) rootLines.push(`  --brand-${k.replaceAll('_', '-')}: ${v};`);
    }
    if (truthy(branding.css_var_overrides)) {
        for (const [k, v] of Object.entries(branding.css_var_overrides)) rootLines.push(`  ${k}: ${v};`);
    }
    if (rootLines.length) styleBlocks.push(':root {\n' + rootLines.join('\n') + '\n}');
    if (truthy(branding.dark_css)) styleBlocks.push('.dark {\n' + branding.dark_css + '\n}');

    if (styleBlocks.length) {
        // Defensive escape — we're concatenating arbitrary CSS into a <style> tag
        const cssPayload = replaceAllLiteral(styleBlocks.join('\n'), '</style>', '<\\/style>');
        parts.push(`<style data-walkthrough-branding="1">\n${cssPayload}\n</style>`);
    }

    // 8. Generated bridge CSS (e.g. the desktop window-bg bridge) — last, so it
    //    wins source-order ties against the compiled stylesheet it derives from.
    if (extraCss) {
        parts.push(`<style data-rtfm-bridge="1">\n${replaceAllLiteral(extraCss, '</style>', '<\\/style>')}\n</style>`);
    }

    return parts.length ? parts.join('\n  ') : TAILWIND_CDN;
}

// ─── SVG sprite inlining ─────────────────────────────────────────────────────
// <use href="icons.svg#gear"> references an external sprite file, which can't
// load from a self-contained file:// mockup (and would be blocked anyway).
// Inline the referenced <symbol>s into a hidden in-document sprite and rewrite
// the hrefs to fragment-only (#gear), which works everywhere.

const SPRITE_USE_RE = /(?:xlink:)?href\s*=\s*["']([^"'#]+\.svg)#([\w:.-]+)["']/gi;

/**
 * Rewrite external sprite refs in <use> to in-document symbols.
 * spriteCache maps basename(lower) → file text (shared across steps).
 */
function inlineSvgSprites(html, projectDir, spriteCache) {
    const refs = [];
    for (const match of html.matchAll(SPRITE_USE_RE)) {
        // Only rewrite refs that appear inside <use …> tags
        const tagStart = match.index > 0 ? html.lastIndexOf('<', match.index - 1) : -1;
        if (tagStart === -1 || !/^<use\b/i.test(html.slice(tagStart, match.index))) continue;
        refs.push([match[0], match[1], match[2]]);
    }
    if (!refs.length) return html;

    const basenames = new Set(refs.map(([, file]) => path.posix.basename(file).toLowerCase()));
    const missing = [...basenames].filter(base => !(base in spriteCache));
    if (missing.length) {
        const lookup = findProjectAssets(projectDir, missing);
        for (const base of missing) spriteCache[base] = base in lookup ? readFileOrEmpty(lookup[base]) : '';
    }

    const symbols = new Map();
    for (const [raw, file, frag] of refs) {
        const sprite = spriteCache[path.posix.basename(file).toLowerCase()] ?? '';
        if (!sprite || symbols.has(frag)) {
            if (sprite) html = replaceAllLiteral(html, raw, `href="#${frag}"`);
            continue;
        }
        const sym = sprite.match(new RegExp(`<symbol\\b[^>]*\\bid\\s*=\\s*["']${escapeRegExp(frag)}["'][\\s\\S]*?</symbol>`, 'i'));
        if (!sym) continue;
        symbols.set(frag, sym[0]);
        html = replaceAllLiteral(html, raw, `href="#${frag}"`);
    }

    if (symbols.size) {
        const spriteSvg = '<svg xmlns="http://www.w3.org/2000/svg" style="display:none" '
            + 'aria-hidden="true" data-rtfm-sprite="1">' + [...symbols.values()].join('') + '</svg>';
        html = html.replace(/(<body\b[^>]*>)/, match => match + spriteSvg);
    }
    return html;
}

/**
 * Mark <html> so the renderers' glyph-substitute fallback CSS (which uses
 * !important) knows real icon fonts are embedded and stands down.
 */
function injectIconFontsMarker(html) {
    if (html.includes('data-rtfm-icon-fonts')) return html;
    return html.replace(/<html(\b[^>]*)?>/, (_, attrs) => `<html${attrs || ''} data-rtfm-icon-fonts="1">`);
}

function injectCss(html, block) {
    if (html.includes('<!-- INJECT_CSS -->')) return replaceAllLiteral(html, '<!-- INJECT_CSS -->', block);
    if (html.includes('</head>')) return replaceAllLiteral(html, '</head>', `${block}\n</head>`);
    if (html.includes('<body')) return replaceFirstLiteral(html, '<body', `${block}\n<body`);
    return `<head>${block}</head>\n${html}`;
}

function escapeText(text) {
    return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function insertHead(html, headInserts) {
    if (html.includes('</head>')) return replaceFirstLiteral(html, '</head>', `${headInserts}\n</head>`);
    if (html.includes('<head')) return html.replace(/(<head[^>]*>)/, match => `${match}\n${headInserts}`);
    return `<head>${headInserts}</head>\n` + html;
}

/**
 * Inject the polish CSS, cross-fade loader, and the zoomable stage wrapper
 * around the mockup content.
 *
 * No caption chrome is added — the step text lives in the narration and the
 * subtitles/transcript, so the mockup owns the full viewport frame.
 * `offsetBridge` is the per-step root-offset bridge <style> (see
 * fixedOffsetBridgeCss) — empty for apps with no root-level chrome offset.
 */
function injectStage(html, offsetBridge = '') {
    let headInserts = `  ${WALKTHROUGH_STYLE}\n  ${WALKTHROUGH_LOADER}`;
    if (offsetBridge && !html.includes('data-rtfm-offset-bridge')) headInserts += `\n  ${offsetBridge}`;
    html = insertHead(html, headInserts);

    const bodyInserts = `\n${STAGE_OPEN}`;
    const bodyMatch = html.match(/<body[^>]*>/);
    if (bodyMatch) {
        const insertAt = bodyMatch.index + bodyMatch[0].length;
        html = html.slice(0, insertAt) + bodyInserts + html.slice(insertAt);
        html = html.includes('</body>') ? replaceFirstLiteral(html, '</body>', STAGE_CLOSE + '\n</body>') : html + STAGE_CLOSE;
    } else {
        html = bodyInserts + html + STAGE_CLOSE;
    }
    return html;
}

/**
 * Add data-walkthrough-wipe-in="1" to the body tag of step_0.html so the
 * radial-wipe CSS in WALKTHROUGH_STYLE fires when the recorder navigates
 * from the intro card to step_0. No-op if the attribute is already present
 * or the body tag is missing.
 */
function injectStepZeroWipe(html) {
    const bodyMatch = html.match(/<body([^>]*)>/);
    if (!bodyMatch) return html;
    const bodyAttrs = bodyMatch[1];
    if (bodyAttrs.includes('data-walkthrough-wipe-in')) return html;
    const newOpen = `<body${bodyAttrs} data-walkthrough-wipe-in="1">`;
    return html.slice(0, bodyMatch.index) + newOpen + html.slice(bodyMatch.index + bodyMatch[0].length);
}

/**
 * Inject just the polish CSS + cross-fade loader for title-card pages.
 * No stage wrapper — the card body controls its own layout.
 */
function injectCardLoader(html) {
    return insertHead(html, `  ${WALKTHROUGH_STYLE}\n  ${WALKTHROUGH_LOADER}`);
}

function buildFilenameLookup(images) {
    const lookup = {};
    for (const [imagePath, uri] of Object.entries(images)) {
        const fname = path.posix.basename(imagePath);
        if (!(fname in lookup)) lookup[fname] = uri;
    }
    return lookup;
}

function makeReplaceImg(images, filenameLookup) {
    return (match, imgName) => {
        for (const key of [imgName, '/' + imgName, '/assets/' + imgName]) {
            if (Object.hasOwn(images, key)) return images[key];
        }
        return Object.hasOwn(filenameLookup, imgName) ? filenameLookup[imgName] : match;
    };
}

function stepIndexFromFilename(fname) {
    const match = fname.match(/^step_(\d+)\.html$/);
    return match ? Number(match[1]) : null;
}

// Title-card filenames. The recorder treats these specially (no advance
// element, fixed display duration). Auto-generated from article.json when
// the walkthrough flag is set.
const INTRO_FILENAME = 'step_intro.html';
const OUTRO_FILENAME = 'step_outro.html';

// Filename fragments that suggest "this image is the project's wordmark/logo".
// Used by findLogo() to pick a brand image for the title cards. Favicons are
// excluded explicitly because they're typically too small (16-32px) to render
// nicely at the 84px card-logo size.
const LOGO_NAME_HINTS = ['logo', 'wordmark', 'brand-mark', 'brandmark', 'brand_logo'];

/** Pick a logo-like filename from the image manifest, if any. */
function findLogo(filenameLookup) {
    const candidates = [];
    for (const name of Object.keys(filenameLookup)) {
        const lower = name.toLowerCase();
        if (lower.includes('favicon')) continue;
        if (LOGO_NAME_HINTS.some(hint => lower.includes(hint))) {
            // Prefer exact "logo.<ext>" matches over hyphenated variants.
            const dot = lower.lastIndexOf('.');
            const base = dot < 0 ? lower : lower.slice(0, dot);
            const rank = base === 'logo' ? 0 : (base.startsWith('logo') ? 1 : 2);
            candidates.push([rank, name]);
        }
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => (a[0] - b[0]) || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
    return candidates[0][1];
}

/** Perceived luminance (0..1) of a #rgb/#rrggbb(aa) colour, or null. */
function hexLuminance(hex) {
    let h = hex.replace(/^#+/, '');
    if (h.length === 3) h = [...h].map(c => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    if (!/^[0-9a-fA-F]{6}/.test(h)) return null;
    const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255.0;
}

// ─── Raster measurement (title cards) ────────────────────────────────────────
// Title-card theming needs pixel data from logos and card backgrounds. The
// renderer's own Chromium decodes every format a mockup can use, so one
// shared headless page does the decoding; the browser starts only when a
// walkthrough actually has a raster to measure.

let rasterPage = null;
let rasterBrowser = null;

async function rasterPixels(dataUri, crop = null) {
    if (!rasterPage) {
        let renderer;
        try { renderer = require('./render_mockup.js'); }
        catch (error) {
            log(`  raster measurement unavailable: ${error.message}`);
            return null;
        }
        rasterBrowser = await renderer.puppeteer.launch(renderer.launchOptions());
        rasterPage = await rasterBrowser.newPage();
    }
    try {
        return await rasterPage.evaluate(async (src, box) => {
            const img = new Image();
            img.src = src;
            await img.decode();
            let [sx, sy, sw, sh] = [0, 0, img.naturalWidth, img.naturalHeight];
            if (!sw || !sh) return null;
            if (box) {
                sx = Math.trunc(sw * box[0]); sy = Math.trunc(sh * box[1]);
                const ex = Math.trunc(img.naturalWidth * box[2]); const ey = Math.trunc(img.naturalHeight * box[3]);
                sw = ex - sx; sh = ey - sy;
            }
            // Fit within 64x64 preserving aspect, never enlarging.
            const scale = Math.min(1, 64 / sw, 64 / sh);
            const w = Math.max(1, Math.round(sw * scale));
            const h = Math.max(1, Math.round(sh * scale));
            const canvas = document.createElement('canvas');
            canvas.width = w; canvas.height = h;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
            return Array.from(ctx.getImageData(0, 0, w, h).data);
        }, dataUri, crop);
    } catch {
        return null;
    }
}

async function closeRaster() {
    if (rasterBrowser) await rasterBrowser.close().catch(() => {});
    rasterBrowser = null;
    rasterPage = null;
}

/**
 * Best-effort ink measurement for a logo data URI. Returns
 * [mean ink luminance 0..1, hasTransparency] or null when undecidable
 * (bad data, unsupported format, or no renderer for rasters).
 *
 * SVG: average the luminance of explicit fill/stroke colours; treated as
 * transparent (SVG marks almost never paint a full background).
 * Raster: alpha-weighted mean luminance of visible pixels; for fully opaque
 * images (e.g. JPEG) near-white pixels are treated as background and
 * excluded so a dark mark on white reads as dark.
 */
async function logoInkStats(dataUri) {
    if (typeof dataUri !== 'string' || !dataUri.includes(',')) return null;
    const comma = dataUri.indexOf(',');
    const header = dataUri.slice(0, comma);
    const raw = Buffer.from(dataUri.slice(comma + 1), 'base64');

    if (header.includes('svg')) {
        const svg = raw.toString('utf8');
        const lums = [...svg.matchAll(/(?:fill|stroke|stop-color)\s*[:=]\s*["']?(#[0-9a-fA-F]{3,8})/g)]
            .map(match => hexLuminance(match[1])).filter(lum => lum !== null);
        if (!lums.length) return null;
        return [lums.reduce((a, b) => a + b, 0) / lums.length, true];
    }

    const data = await rasterPixels(dataUri);
    if (!data) return null;
    let hasAlpha = false;
    for (let i = 3; i < data.length; i += 4) if (data[i] < 250) { hasAlpha = true; break; }
    const samples = [];
    for (let i = 0; i < data.length; i += 4) {
        const lum = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) / 255.0;
        if (hasAlpha) { if (data[i + 3] >= 64) samples.push(lum); }
        else if (lum <= 0.95) samples.push(lum);
    }
    if (samples.length < 10) return null;
    return [samples.reduce((a, b) => a + b, 0) / samples.length, hasAlpha];
}

/**
 * Best-effort: is the logo's ink predominantly dark? true -> the logo
 * needs a light card; false -> a dark card. null when undecidable.
 */
async function logoIsDark(dataUri) {
    const stats = await logoInkStats(dataUri);
    return stats === null ? null : stats[0] < 0.55;
}

/**
 * Mean perceived luminance (0..1) of the central region of a card
 * background image — the area the logo and title sit over (the gradient's
 * corner glows are deliberately cropped out). null when unreadable.
 */
async function cardBgLuminance(file) {
    let raw;
    try { raw = fs.readFileSync(file); } catch { return null; }
    const mime = CARD_LOGO_MIMES[path.extname(file).toLowerCase()] ?? 'image/png';
    const data = await rasterPixels(`data:${mime};base64,${raw.toString('base64')}`, [0.20, 0.22, 0.80, 0.78]);
    if (!data || !data.length) return null;
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) sum += (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) / 255.0;
    return sum / (data.length / 4);
}

/**
 * Light card for dark logos, dark card for light logos. Defaults to
 * light when there is no logo or its ink colour can't be determined.
 */
async function pickCardTheme(logoFilename, filenameLookup) {
    if (!logoFilename) return 'light';
    const darkLogo = await logoIsDark(filenameLookup[logoFilename]);
    return darkLogo === false ? 'dark' : 'light';
}

/**
 * Produce raw HTML for an intro or outro title card. Contains the same
 * {{img:...}} and <!-- INJECT_CSS --> placeholders as a normal step file,
 * so the existing CSS + image substitution still applies.
 *
 * backgroundImage (card_bg.png) sits on a dedicated sibling div so it can be
 * scale-transformed for the Ken Burns effect without affecting card content.
 * logoDataUri (the account's uploaded branding logo) is embedded directly and
 * takes precedence over logoFilename (the repo-detected logo resolved from
 * the image manifest). logoPlate ("light"/"dark") adds a translucent contrast
 * plate behind the logo.
 */
function buildCardHtml({ kind, title, tagline, logoFilename, backgroundImage = null, theme = 'light', logoDataUri = null, logoPlate = null }) {
    const safeTitle = escapeText(title || '');
    const safeTagline = escapeText(tagline || '');
    const plateClass = logoPlate ? ` walkthrough-card-logo--plate-${logoPlate}` : '';
    let logoHtml = '';
    if (logoDataUri) logoHtml = `<img class="walkthrough-card-logo${plateClass}" src="${logoDataUri}" alt="">`;
    else if (logoFilename) logoHtml = `<img class="walkthrough-card-logo${plateClass}" src="{{img:${logoFilename}}}" alt="">`;
    const taglineHtml = safeTagline ? `<p class="walkthrough-card-tagline">${safeTagline}</p>` : '';
    // Body keeps its flat brand-colour fallback (set in WALKTHROUGH_STYLE) so a
    // missing image degrades to a clean coloured frame rather than a white flash.
    const bgHtml = backgroundImage
        ? `<div class="walkthrough-card-bg" style="background-image:url('${backgroundImage.replaceAll("'", '%27')}');"></div>`
        : '';
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${safeTitle}</title>
<!-- INJECT_CSS -->
</head>
<body data-walkthrough-card="${kind}" data-card-theme="${theme}" data-viewport="wide">
  ${bgHtml}
  <div class="walkthrough-card">
    ${logoHtml}
    <h1 class="walkthrough-card-title"><span class="walkthrough-card-title-text">${safeTitle}</span></h1>
    ${taglineHtml}
  </div>
</body>
</html>
`;
}

// Filename of the card background (when present). It lives in the
// project-level .rtfm/ cache (legacy: .rtfm-branding/); this module copies it
// into each walkthrough's output dir at process time so the title-card HTML
// can reference it with a relative path (the same pattern as branding.css).
const CARD_BG_FILENAME = 'card_bg.png';

/** Resolve a cached card background PNG next to branding.json, or null. */
function findCardBg(brandingJsonPath) {
    if (!brandingJsonPath) return null;
    const candidate = path.join(path.dirname(brandingJsonPath) || '.', CARD_BG_FILENAME);
    return isFile(candidate) ? candidate : null;
}

// The account's branding logo, seeded into .rtfm/ as card_logo.<ext>. When
// present it overrides the repo-detected logo on the title cards.
const CARD_LOGO_MIMES = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml', '.webp': 'image/webp', '.gif': 'image/gif',
};

/** Resolve the branding logo (card_logo.<ext>) next to branding.json, or null. */
function findCardLogo(brandingJsonPath) {
    if (!brandingJsonPath) return null;
    const dir = path.dirname(brandingJsonPath) || '.';
    for (const ext of Object.keys(CARD_LOGO_MIMES)) {
        const candidate = path.join(dir, `card_logo${ext}`);
        if (isFile(candidate)) return candidate;
    }
    return null;
}

/** Read a logo file into a base64 data URI for direct embedding, or null. */
function cardLogoDataUri(file) {
    if (!file || !isFile(file)) return null;
    const mime = CARD_LOGO_MIMES[path.extname(file).toLowerCase()] ?? 'image/png';
    try { return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`; }
    catch { return null; }
}

function sameFile(a, b) {
    try {
        const [sa, sb] = [fs.statSync(a), fs.statSync(b)];
        return sa.dev === sb.dev && sa.ino === sb.ino;
    } catch { return false; }
}

/**
 * Write step_intro.html + step_outro.html in htmlDir using article-level
 * metadata from the merged walkthrough data. Skips emission when article
 * info is empty (e.g. article.json was missing).
 *
 * When cardBgSource is a path to an existing PNG, the file is copied into
 * htmlDir as card_bg.png and referenced as the card body's background-image.
 */
async function writeTitleCards(htmlDir, walkthroughData, filenameLookup, { cardBgSource = null, cardLogoSource = null } = {}) {
    if (!walkthroughData) return [];
    const article = walkthroughData.article || {};
    const title = String(article.title || '').trim();
    if (!title) return [];
    const introTagline = String(article.introduction || '').trim();
    const outroTagline = String(article.summary || '').trim();
    // The account's uploaded branding logo (if seeded) wins over the
    // repo-detected one. Theme follows whichever logo is used.
    const logoUri = cardLogoDataUri(cardLogoSource);
    const logo = logoUri ? null : findLogo(filenameLookup);
    let theme;
    let logoLabel;
    if (logoUri) {
        theme = (await logoIsDark(logoUri)) === false ? 'dark' : 'light';
        logoLabel = 'branding';
    } else {
        theme = await pickCardTheme(logo, filenameLookup);
        logoLabel = logo || 'none';
    }

    let backgroundImage = null;
    let logoPlate = null;
    if (cardBgSource && isFile(cardBgSource)) {
        const dest = path.join(htmlDir, CARD_BG_FILENAME);
        // Skip the copy if dest is already the same file (e.g. running in place).
        if (!sameFile(cardBgSource, dest)) fs.copyFileSync(cardBgSource, dest);
        backgroundImage = CARD_BG_FILENAME;
        // The image covers the theme's flat background, so the logo-derived
        // theme no longer guarantees contrast. Re-pick the text theme from
        // the image's own luminance, and plate the logo when its ink sits
        // near the background's (green logo on a green gradient). Opaque
        // rasters skip the plate — they carry their own background box.
        const bgLum = await cardBgLuminance(dest);
        if (bgLum !== null) {
            theme = bgLum < 0.55 ? 'dark' : 'light';
            const ink = await logoInkStats(logoUri || (logo ? filenameLookup[logo] : null));
            if (ink !== null) {
                const [inkLum, transparent] = ink;
                if (transparent && Math.abs(inkLum - bgLum) < 0.35) logoPlate = inkLum < 0.55 ? 'light' : 'dark';
            }
        }
    }
    const plateNote = logoPlate ? `, ${logoPlate} logo plate` : '';
    const bgNote = backgroundImage ? `, bg image${plateNote}` : '';
    log(`  title cards: ${theme} theme (logo: ${logoLabel}${bgNote})`);

    const shared = { title, logoFilename: logo, backgroundImage, theme, logoDataUri: logoUri, logoPlate };
    fs.writeFileSync(path.join(htmlDir, INTRO_FILENAME), buildCardHtml({ kind: 'intro', tagline: introTagline, ...shared }));
    fs.writeFileSync(path.join(htmlDir, OUTRO_FILENAME), buildCardHtml({ kind: 'outro', tagline: outroTagline, ...shared }));
    return [INTRO_FILENAME, OUTRO_FILENAME];
}

async function processDir(htmlDir, cssFile, imagesJson, actionsJson, brandingJson = null, generatedImagesJson = null, refreshJit = false) {
    const cssContent = loadCss(cssFile);
    const images = loadImages(imagesJson);
    const generatedImages = loadGeneratedImages(generatedImagesJson);
    const walkthroughData = loadWalkthroughSteps(actionsJson);
    const branding = loadBranding(brandingJson);

    if (!isDir(htmlDir)) {
        log(`Error: ${htmlDir} is not a directory`);
        return 1;
    }

    const projectDir = process.cwd();
    const cacheDir = brandingJson ? path.dirname(path.resolve(brandingJson)) : htmlDir;
    const compiledCssPath = branding && truthy(branding.compiled_css_path) ? branding.compiled_css_path : null;

    // Inline relative url() assets in the compiled CSS so background-image
    // classes render their real artwork instead of a blank region.
    if (compiledCssPath) {
        const outCss = path.join(htmlDir, compiledCssPath);
        if (isFile(outCss)) {
            const inlined = inlineCssAssetUrls(outCss, projectDir);
            if (inlined) {
                log(`  inlined ${inlined} CSS url() asset(s) into ${compiledCssPath}`);
                // Persist back to the project cache so future runs reuse the inlined version.
                const cacheCss = path.join(cacheDir, compiledCssPath);
                if (isFile(cacheCss) && path.resolve(cacheCss) !== path.resolve(outCss)) {
                    try { fs.writeFileSync(cacheCss, fs.readFileSync(outCss, 'utf8')); }
                    catch (error) { log(`WARNING: could not persist inlined CSS to cache: ${error.message}`); }
                }
            }
        }
    }

    // Render-time JIT (deterministic — not left to the model's bash block): when the
    // project has a cached Tailwind `css_build` recipe, locally compile the mockups'
    // OWN classes into <htmlDir>/mockup.css via jit_mockup_css.js, so arbitrary /
    // responsive / plugin classes render without the flaky Play CDN. Runs from here
    // so it always fires. Skips cleanly (no mockup.css) when there's no recipe.
    const mockupCssFile = path.join(htmlDir, 'mockup.css');
    let recipe = null;
    const projectMap = path.join(cacheDir, 'project_map.json');
    try { recipe = readJson(projectMap).css_build ?? null; } catch { /* no recipe */ }
    const jitPath = path.join(__dirname, 'jit_mockup_css.js');
    // Progressive article rendering calls the injector after each newly authored
    // mockup. Rebuild the JIT bundle so classes introduced by that step are
    // available immediately; the normal final/batch path keeps its cached bundle.
    if (refreshJit && isFile(mockupCssFile)) {
        try { fs.rmSync(mockupCssFile); }
        catch (error) { log(`WARNING: could not refresh ${mockupCssFile}: ${error.message}`); }
    }
    if (truthy(recipe) && !isFile(mockupCssFile) && isFile(jitPath)) {
        const jitLog = path.join(htmlDir, 'jit.log');
        const r = spawnSync(process.execPath, [jitPath, htmlDir, projectDir, projectMap], { timeout: 180000, encoding: 'utf8' });
        if (r.error) {
            // Never let the JIT break injection.
            fs.writeFileSync(jitLog, `jit invocation EXCEPTION: ${r.error.message}\ncwd=${process.cwd()}\nproject_dir=${projectDir}\n`);
            log(`  jit invocation error (keeping CDN/compiled CSS): ${r.error.message}`);
        } else {
            fs.writeFileSync(jitLog, `cwd=${process.cwd()}\nproject_dir=${projectDir}\njit_path=${jitPath}\n`
                + `rc=${r.status}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}\n`);
            if (r.stderr) log(r.stderr);
        }
    }
    const jitCss = isFile(mockupCssFile) ? 'mockup.css' : null;
    if (jitCss) log('  using local JIT mockup.css (dropping Tailwind CDN)');
    // Treat a project with a Tailwind recipe as Tailwind-family for the CDN fallback,
    // so a framework like "phoenix" still gets coverage if the JIT couldn't run.
    const twHint = Boolean(isObject(recipe) && truthy(recipe.tw_version));

    const htmlFiles = fs.readdirSync(htmlDir).sort();

    // Desktop mockups: bridge body-scoped app backgrounds into the framed window
    // interior. Gated on the mockups actually using the desktop frame, so web /
    // terminal / mobile output is untouched.
    let bridgeCss = '';
    const usesDesktopFrame = htmlFiles.some(f => f.endsWith('.html') && readFileOrEmpty(path.join(htmlDir, f)).includes('desktop-window-content'));
    if (usesDesktopFrame) {
        const bridgeSources = [cssContent || ''];
        if (compiledCssPath) bridgeSources.push(readFileOrEmpty(path.join(htmlDir, compiledCssPath)));
        bridgeCss = desktopWindowBgBridge(bridgeSources.join('\n'));
        if (bridgeCss) {
            log(`  desktop window-bg bridge: ${bridgeCss.split('{').length - 1} body-background rule(s) re-emitted onto .desktop-window-content`);
        }
    }

    // CSS text the walkthrough root-offset bridge scans: css_content plus the
    // compiled CSS file sitting next to the mockups (the walkthrough SKILL passes
    // css_file="" and the compiled CSS rides --branding's compiled_css_path).
    let offsetBridgeCss = cssContent || '';
    if (compiledCssPath) offsetBridgeCss += '\n' + readFileOrEmpty(path.join(htmlDir, compiledCssPath));

    // Sentinel so a re-run (STEP 4 lint-retry) can detect already-injected HTML
    // and skip re-injecting — otherwise the whole block stacks a 2nd/3rd time.
    // Prepended to the block itself so it's ALWAYS present regardless of which
    // optional sub-blocks buildCssHeadBlock emits.
    let block = INJECTED_SENTINEL + '\n' + buildCssHeadBlock(cssContent, branding, { jitCss, twHint, extraCss: bridgeCss });

    // Embed real icon fonts when the mockups use icon classes (fa-*/bi-*).
    const iconCss = await ensureIconFonts(htmlDir, cacheDir);
    if (iconCss) block += `\n  <link rel="stylesheet" href="${iconCss}">`;
    const filenameLookup = buildFilenameLookup(images);
    const replaceImg = makeReplaceImg(images, filenameLookup);

    const walkthroughSteps = walkthroughData ? walkthroughData.steps : null;
    let cardsWritten = [];
    // Account branding drives the cards: card_bg.png (a brand-colour gradient
    // rendered from the account's colours, or a user upload) as the background,
    // and card_logo.<ext> (the account's uploaded logo) overlaid. Both are
    // resolved next to branding.json; when absent the cards fall back to the
    // CSS gradient theme + repo logo.
    const cardBgSource = walkthroughData ? findCardBg(brandingJson) : null;
    const cardLogoSource = walkthroughData ? findCardLogo(brandingJson) : null;
    try {
        if (walkthroughData) cardsWritten = await writeTitleCards(htmlDir, walkthroughData, filenameLookup, { cardBgSource, cardLogoSource });
    } finally {
        await closeRaster();
    }

    let count = 0;
    const spriteCache = {};
    for (const fname of fs.readdirSync(htmlDir).sort()) {
        if (!(fname.startsWith('step_') || fname.startsWith('block_')) || !fname.endsWith('.html')) continue;
        const fpath = path.join(htmlDir, fname);
        let html = fs.readFileSync(fpath, 'utf8');

        // Preserve the pre-injection source for the screen library. Numbered
        // step mockups only (not the auto-generated intro/outro cards), and
        // only when the CSS placeholder is still present -- STEP 4 re-runs
        // (lint retry) on already-injected HTML must not clobber the backup.
        // ".html.pre" deliberately does not end in ".html" so this loop's
        // filter never re-processes it.
        if (/^(?:step_\d+|block_[a-z0-9]+(?:-[a-z0-9]+)*)\.html$/.test(fname) && html.includes('<!-- INJECT_CSS -->')) {
            fs.writeFileSync(fpath + '.pre', html);
        }

        // Idempotent CSS injection. STEP 4's lint-retry re-runs processDir on
        // already-injected HTML (the model edits the injected step file to fix a
        // lint failure, then re-injects). The <!-- INJECT_CSS --> marker is gone
        // by then, so a naive injectCss() falls through to the </head> branch and
        // stamps a SECOND (then THIRD) copy of the whole block mid-document. If
        // our sentinel is already present, skip re-injecting.
        if (!html.includes(INJECTED_SENTINEL)) html = injectCss(html, block);
        if (iconCss) html = injectIconFontsMarker(html);
        html = inlineSvgSprites(html, projectDir, spriteCache);
        html = html.replace(/\{\{img:([^}]+)\}\}/g, replaceImg);
        html = html.replace(/\{\{generated:([a-z0-9]+(?:-[a-z0-9]+)*)\}\}/g,
            (match, id) => (Object.hasOwn(generatedImages, id) ? generatedImages[id] : match));

        const isCard = fname === INTRO_FILENAME || fname === OUTRO_FILENAME;
        if (walkthroughSteps !== null) {
            if (isCard) {
                html = injectCardLoader(html);
            } else {
                const idx = stepIndexFromFilename(fname);
                if (idx !== null && idx < walkthroughSteps.length) {
                    html = injectStage(html, fixedOffsetBridgeCss(html, offsetBridgeCss));
                    // Only step_0 gets the radial wipe — used as the cinematic
                    // reveal out of the intro card. Step-to-step transitions
                    // keep the existing brand-wash cross-fade.
                    if (idx === 0) html = injectStepZeroWipe(html);
                }
            }
        }

        fs.writeFileSync(fpath, html);
        count += 1;
        log(`  injected: ${fname}`);
    }

    let styleLabel;
    if (compiledCssPath) styleLabel = `compiled CSS (${branding.framework || 'detected'})`;
    else if (branding && truthy(branding.framework_cdn)) styleLabel = `${branding.framework ?? 'None'} CDN`;
    else if (cssContent) styleLabel = 'compiled CSS (legacy --css)';
    else styleLabel = 'Tailwind CDN';
    const extras = [];
    if (walkthroughSteps !== null) extras.push(`${walkthroughSteps.length} step stage(s)`);
    if (cardsWritten.length) extras.push(`${cardsWritten.length} title card(s)${cardBgSource ? ' with AI background' : ''}`);
    if (branding) {
        if (truthy(branding.root_css)) extras.push('root vars');
        if (truthy(branding.default_colors)) extras.push(`${Object.keys(branding.default_colors).length} brand colours`);
        if (truthy(branding.google_fonts)) extras.push(`${branding.google_fonts.length} font(s)`);
    }
    if (Object.keys(generatedImages).length) extras.push(`${Object.keys(generatedImages).length} generated image(s)`);
    const extrasStr = extras.length ? `, ${extras.join(', ')}` : '';
    log(`${count} file(s) processed (${styleLabel}, ${Object.keys(images).length} image entries${extrasStr})`);
    return 0;
}

/**
 * Stamp the running skills version + this file's content hash to stderr, so a
 * debug bundle reveals exactly which code ran. The hash is authoritative (it
 * works even when the VERSION file isn't in a vendored tree).
 */
function logSkillsVersion() {
    const here = path.dirname(fs.realpathSync(__filename));
    let version = 'unknown';
    for (const candidate of [path.join(here, '..', '..', 'VERSION'), path.join(here, '..', 'VERSION')]) {
        try {
            const v = fs.readFileSync(candidate, 'utf8').trim();
            if (v) { version = v; break; }
        } catch { /* try the next */ }
    }
    let sha = '?';
    try { sha = crypto.createHash('sha256').update(fs.readFileSync(fs.realpathSync(__filename))).digest('hex').slice(0, 8); }
    catch { /* unreadable */ }
    log(`rtfm-skills inject_assets.js — v${version} (sha ${sha})`);
}

const USAGE = 'usage: inject_assets.js <html_dir> <css_file_or_empty> <images_json> [--walkthrough <actions_json>] '
    + '[--branding <branding_json>] [--generated-images <generated_images_json>] [--refresh-jit]';

function parseArgs(argv) {
    const valued = { '--walkthrough': 'walkthrough', '--branding': 'branding', '--generated-images': 'generatedImages' };
    const options = { walkthrough: null, branding: null, generatedImages: null, refreshJit: false };
    const positional = [];
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const eq = arg.indexOf('=');
        const name = arg.startsWith('--') && eq > 0 ? arg.slice(0, eq) : arg;
        if (name === '--refresh-jit' && eq < 0) options.refreshJit = true;
        else if (Object.hasOwn(valued, name)) {
            const value = eq > 0 ? arg.slice(eq + 1) : argv[++i];
            if (value === undefined) throw new Error(`argument ${name}: expected one argument`);
            options[valued[name]] = value;
        } else if (arg === '--help' || arg === '-h') {
            process.stdout.write(USAGE + '\n');
            process.exit(0);
        } else if (arg.startsWith('--') && arg.length > 2) {
            throw new Error(`unrecognized arguments: ${arg}`);
        } else {
            positional.push(arg);
        }
    }
    if (positional.length !== 3) throw new Error(positional.length < 3 ? 'the following arguments are required: html_dir, css_file, images_json' : `unrecognized arguments: ${positional.slice(3).join(' ')}`);
    return { positional, options };
}

async function main(argv) {
    logSkillsVersion();
    let parsed;
    try { parsed = parseArgs(argv); }
    catch (error) {
        log(`${USAGE}\ninject_assets.js: error: ${error.message}`);
        return 2;
    }
    const [htmlDir, cssFile, imagesJson] = parsed.positional;
    const { walkthrough, branding, generatedImages, refreshJit } = parsed.options;
    return processDir(htmlDir, cssFile, imagesJson, walkthrough, branding, generatedImages, refreshJit);
}

if (require.main === module) {
    main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
        log(error.stack || String(error));
        process.exitCode = 1;
    });
}

module.exports = {
    processDir,
    buildCssHeadBlock,
    desktopWindowBgBridge,
    fixedOffsetBridgeCss,
    fontDescriptorToUrl,
    firstGoogleFontFamily,
    inlineSvgSprites,
    injectCss,
    injectStage,
    findLogo,
    buildCardHtml,
};
