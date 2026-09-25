#!/usr/bin/env node
/**
 * lint_mockup_fidelity.js
 *
 * Verifies each step_N.html in <output_dir> was authored from real project
 * view files rather than invented. Reads view_sources.json (produced by the
 * SKILL before the mockups are written) and runs six checks per step:
 *
 *   1. primary_view exists in the project
 *   2. inline <style> blocks don't define classes that are absent from the
 *      listed source files + branding.css
 *   2b. colour values in inline style attributes, model-authored <style>
 *      blocks, SVG fill/stroke attrs, and Tailwind arbitrary values exist in
 *      branding.css or the step's source files (neutrals always allowed)
 *   3. verbatim_evidence strings appear in both the named source file and
 *      the mockup HTML; multi-word phrases in the mockup that look like
 *      invented copy are warned
 *   4. default_user_assumptions with markup_absence_check substrings hold
 *   5. <body> class in mockup contains every token from the layout <body>
 *   6. (walkthroughs) step 0 depicts the default landing route
 *   7. (walkthroughs) interaction wiring: exactly one data-walkthrough-action=
 *      "advance" per non-final step (none on the last) linking to the next
 *      step; every data-walkthrough-type-into is a real <input>/<textarea>
 *      with non-empty type-text; every data-walkthrough-do pre-action is a
 *      kind the recorder handles (scroll-to/hover/click/select/check/swipe) with a
 *      sane order/value; and (when narration.json is present) the spoken
 *      narration doesn't promise an interaction the mockup never performs.
 *      Catches the "cursor clicks the wrong element" class of bug, which
 *      nothing else guards. Gated on actions.json existing next to the
 *      mockups, so articles skip it.
 *   9. (articles) zero-based article/view/file indices agree, and every
 *      imperative UI-action step has an action_coverage entry whose selected
 *      mockup visibly marks the source-grounded control in its action-ready
 *      state. A post-action result cannot substitute for a missing target.
 *
 * Exits 0 if all steps pass, 1 if any step has errors, 2 on bad input.
 * Always writes <output_dir>/lint_report.json so the SKILL can feed
 * structured findings into a regeneration prompt.
 *
 * Deterministic metrics (additive, benchmark-facing). Every step/block entry
 * carries a `metrics` object and the report carries a report-level `metrics`
 * object. Each value mirrors a count a check above already makes:
 * `{hits, total, ratio}` per check, `{count}` for invented colours / invented
 * copy / undefined vars, and `null` when that check's data gate was not met
 * (never 0/0). Per-step keys, in order: shell_nav_labels, chrome_files_expanded,
 * runtime_ui_strings, runtime_regions_rendered, root_classes_html,
 * layout_root_classes, verbatim_evidence_source, verbatim_evidence_html,
 * partials_present, body_class_tokens, styled_coverage, inline_classes_verified,
 * invented_colours, invented_copy. Report-level keys: action_coverage,
 * runtime_states_selected, undefined_css_vars, errors_total, warnings_total.
 * Per-layout counters SUM across a step's claimed layouts; runtime_ui_strings
 * is measured on every schema but only enforced (warning) on legacy maps;
 * invented_* counts are uncapped while the messages keep their 10-entry cap.
 * Metrics never influence errors, warnings, message text, or the exit code —
 * An offline scorer reads them to measure chrome completeness without a judge.
 *
 * Usage: lint_mockup_fidelity.js <output_dir> [<project_dir>]
 *        project_dir defaults to cwd.
 */

const fs = require('fs');
const path = require('path');
const {
    ALLOWED_KINDS: GENERATED_KINDS,
    ALLOWED_EXTERNAL_SURFACES: EXTERNAL_SURFACES,
    ALLOWED_SOURCE_BASES: EXTERNAL_SOURCE_BASES,
} = require('./generate_content_images.js');
const includeCensus = require('./include_census.js');
const { verifyLabelEvidence } = require('./label_evidence.js');

// Project-relative, or ../<repo>/<path> into a related repository.
const { isSafeSourcePath: isSafeProjectRelativePath, sourceExists } = require('./source_paths.js');

function loadFileOrEmpty(p) {
    try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function dataAttrTags(html, attr, value = null) {
    const out = [];
    const attrRe = new RegExp(`\\b${escapeRegex(attr)}\\s*=\\s*["']([^"']+)["']`, 'i');
    for (const m of html.matchAll(/<[a-zA-Z][^>]*>/g)) {
        const hit = m[0].match(attrRe);
        if (hit && (value == null || hit[1] === value)) out.push({ tag: m[0], value: hit[1] });
    }
    return out;
}

function sameStringSet(a, b) {
    const aa = [...new Set((a || []).filter(v => typeof v === 'string'))].sort();
    const bb = [...new Set((b || []).filter(v => typeof v === 'string'))].sort();
    return aa.length === bb.length && aa.every((v, i) => v === bb[i]);
}

function sameStringArray(a, b) {
    return Array.isArray(a) && Array.isArray(b)
        && a.length === b.length && a.every((value, index) => value === b[index]);
}

// ─── Deterministic metrics (additive, benchmark-facing) ─────────────────────
// See the header comment. Keys are pre-seeded to null so the JSON key order is
// stable regardless of which data-gated checks fire for a given step.
const STEP_METRIC_KEYS = [
    'shell_nav_labels', 'chrome_files_expanded', 'runtime_ui_strings', 'runtime_regions_rendered',
    'root_classes_html', 'layout_root_classes', 'verbatim_evidence_source', 'verbatim_evidence_html',
    'partials_present', 'body_class_tokens', 'styled_coverage', 'inline_classes_verified',
    'invented_colours', 'invented_copy', 'screen_closure',
];
function emptyStepMetrics() {
    return Object.fromEntries(STEP_METRIC_KEYS.map(k => [k, null]));
}
function metricRatio(hits, total) {            // callers guarantee total > 0
    return { hits, total, ratio: Math.round((hits / total) * 1000) / 1000 };
}

// Emoji / pictographic glyphs must never stand in for UI icons — real products
// use SVG or icon-font icons, so an emoji reads as unprofessional and off-brand.
// Weaker models take this shortcut on icon-dense screens (e.g. 🔗 📋 ⚙ for
// copy-link / clipboard / settings). Flags both literal emoji AND their numeric
// or hex HTML entities (e.g. &#128279; / &#x1F517;). Allowlists the check/cross
// marks (✓ ✔ ✖ ✗ ✘), which are common legit UI glyphs.
const EMOJI_ALLOW = new Set([0x2713, 0x2714, 0x2716, 0x2717, 0x2718]);
function isEmojiCodepoint(cp) {
    if (EMOJI_ALLOW.has(cp)) return false;
    return (
        (cp >= 0x1F000 && cp <= 0x1FAFF) ||   // emoji & pictographs (🔗 📋 …)
        (cp >= 0x2600 && cp <= 0x26FF) ||     // misc symbols (⚙ ☀ ⭐ …)
        (cp >= 0x2700 && cp <= 0x27BF) ||     // dingbats (✂ ✏ ➜ …)
        cp === 0xFE0F                          // emoji variation selector
    );
}
function findEmojiIcons(html) {
    const found = new Set();
    for (const ch of html) {                 // iterates by code point
        if (isEmojiCodepoint(ch.codePointAt(0))) found.add(ch);
    }
    for (const m of html.matchAll(/&#(x?)([0-9a-fA-F]+);/g)) {
        const cp = parseInt(m[2], m[1] ? 16 : 10);
        if (Number.isFinite(cp) && isEmojiCodepoint(cp)) found.add(String.fromCodePoint(cp));
    }
    return [...found];
}

function extractInlineStyleClassSelectors(html) {
    // Skip <style> blocks injected by the post-processor (branding, polish,
    // caption strip). Those carry data-walkthrough-* marker attributes and
    // are NOT authored by the model.
    const selectors = new Set();
    const styleBlocks = [...html.matchAll(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi)];
    for (const [, attrs, body] of styleBlocks) {
        if (/data-walkthrough-/.test(attrs)) continue;
        const cleaned = body.replace(/\/\*[\s\S]*?\*\//g, '');
        const classMatches = cleaned.matchAll(/(?:^|[\s,>+~])\.([_a-zA-Z][\w-]*)/g);
        for (const [, name] of classMatches) selectors.add(name);
    }
    return [...selectors];
}

function classDefinedInBranding(brandingCss, className) {
    if (!brandingCss) return false;
    const re = new RegExp('\\.' + escapeRegex(className) + '(?![\\w-])');
    return re.test(brandingCss);
}

function classMentionedInProject(projectDir, sourceFiles, className) {
    const needle = new RegExp(
        '(?:class|className)\\s*=\\s*["\'`][^"\'`]*\\b' + escapeRegex(className) + '\\b',
        ''
    );
    for (const rel of sourceFiles) {
        const text = loadFileOrEmpty(path.join(projectDir, rel));
        if (text && needle.test(text)) return true;
    }
    return false;
}

// ─── Invented-colour detection (check 2b) ────────────────────────────────────

const COLOUR_HEX_RE = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![0-9a-fA-F])/g;
const COLOUR_FUNC_RE = /\b(rgba?|hsla?)\(\s*([^)]+)\)/gi;

// data: URIs and url(#fragment) references contain hex-like noise — blank
// url() payloads before tokenizing any text for colours.
function stripUrls(text) {
    return text.replace(/url\(\s*[^)]*\)/gi, 'url()');
}

function hslToRgb(h, s, l) {
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    let rgb;
    if (h < 60) rgb = [c, x, 0];
    else if (h < 120) rgb = [x, c, 0];
    else if (h < 180) rgb = [0, c, x];
    else if (h < 240) rgb = [0, x, c];
    else if (h < 300) rgb = [x, 0, c];
    else rgb = [c, 0, x];
    return rgb.map(v => Math.round((v + m) * 255));
}

function parseHexColour(hex) {
    let h = hex.slice(1);
    let alpha = 1;
    if (h.length === 3 || h.length === 4) h = [...h].map(c => c + c).join('');
    if (h.length === 8) { alpha = parseInt(h.slice(6, 8), 16) / 255; h = h.slice(0, 6); }
    if (h.length !== 6) return null;
    const n = parseInt(h, 16);
    if (Number.isNaN(n)) return null;
    return { rgb: [n >> 16, (n >> 8) & 0xff, n & 0xff], alpha };
}

function parseColourFunc(fn, args) {
    // Handles comma and space/slash syntax, decimals (sass emits
    // rgb(232.6, ...)), and % channels.
    const parts = args.trim().split(/[,\s/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    let alpha = 1;
    if (parts.length >= 4) {
        const a = parseFloat(parts[3]);
        if (!Number.isNaN(a)) alpha = parts[3].includes('%') ? a / 100 : a;
    }
    if (fn.startsWith('rgb')) {
        const ch = parts.slice(0, 3).map(p => {
            const v = parseFloat(p);
            if (Number.isNaN(v)) return null;
            return p.includes('%') ? v * 2.55 : v;
        });
        if (ch.some(v => v == null)) return null;
        return { rgb: ch.map(v => Math.round(Math.min(255, Math.max(0, v)))), alpha };
    }
    const h = parseFloat(parts[0]);
    let s = parseFloat(parts[1]);
    let l = parseFloat(parts[2]);
    if ([h, s, l].some(Number.isNaN)) return null;
    if (parts[1].includes('%') || s > 1) s /= 100;
    if (parts[2].includes('%') || l > 1) l /= 100;
    return { rgb: hslToRgb(((h % 360) + 360) % 360, Math.min(1, s), Math.min(1, l)), alpha };
}

// Returns [{ raw, rgb: [r,g,b], alpha }] for every colour token in the text.
function extractColourTokens(text) {
    const out = [];
    for (const m of text.matchAll(COLOUR_HEX_RE)) {
        const parsed = parseHexColour(m[0]);
        if (parsed) out.push({ raw: m[0], ...parsed });
    }
    for (const m of text.matchAll(COLOUR_FUNC_RE)) {
        const parsed = parseColourFunc(m[1].toLowerCase(), m[2]);
        if (parsed) out.push({ raw: m[0], ...parsed });
    }
    return out;
}

function colourKey(rgb) { return rgb.join(','); }

// Greys and near-greys (incl. cool/warm UI greys like a tinted slate), near-whites,
// and near-blacks are never worth flagging — invented *brand* colours are mid-range
// and saturated. We gate on HSV saturation rather than raw channel spread so that
// common framework neutral greys (whose channels are slightly tinted across the
// brightness range) read as neutral; saturated brand colours stay flagged.
function isNeutralColour(rgb) {
    const max = Math.max(...rgb), min = Math.min(...rgb);
    if (min >= 240 || max <= 48) return true;         // near-white / near-black
    const chroma = max - min;
    const sat = max === 0 ? 0 : chroma / max;         // HSV saturation
    // Low-saturation greys (bright/mid, incl. tinted framework neutrals) OR
    // low-chroma greys (dark neutrals, where HSV saturation inflates as the
    // brightness drops). Saturated brand colours clear both bars and stay flagged.
    return sat <= 0.22 || chroma <= 40;
}

function buildColourWhitelist(cssText) {
    const exact = new Set();
    const list = [];
    if (cssText) {
        for (const { rgb } of extractColourTokens(stripUrls(cssText))) {
            const key = colourKey(rgb);
            if (!exact.has(key)) { exact.add(key); list.push(rgb); }
        }
    }
    return { exact, list };
}

// ±tol per channel absorbs sass rounding / compilation drift.
function nearAnyColour(rgb, list, tol) {
    for (const w of list) {
        if (Math.abs(rgb[0] - w[0]) <= tol && Math.abs(rgb[1] - w[1]) <= tol && Math.abs(rgb[2] - w[2]) <= tol) return true;
    }
    return false;
}

function colourAllowed(rgb, alpha, whitelists) {
    if (alpha === 0) return true; // standard gradient/shadow endpoint
    if (isNeutralColour(rgb)) return true;
    const key = colourKey(rgb);
    for (const wl of whitelists) {
        if (wl.exact.has(key) || nearAnyColour(rgb, wl.list, 3)) return true;
    }
    return false;
}

// Collect the model-authored fragments that may carry colour values: inline
// style attributes, SVG presentation attributes, Tailwind arbitrary values,
// and non-injected <style> blocks. Tags/blocks carrying data-walkthrough
// markers were injected by the post-processor and are skipped.
function extractAuthoredColourChunks(html) {
    const chunks = [];
    const cleaned = html.replace(/<!--[\s\S]*?-->/g, ' ');

    for (const tagMatch of cleaned.matchAll(/<[a-zA-Z][^>]*>/g)) {
        const tag = tagMatch[0];
        if (/data-walkthrough/.test(tag)) continue;
        const style = tag.match(/\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
        if (style) {
            const value = style[1] ?? style[2] ?? '';
            chunks.push({ text: value, context: `style="${value.slice(0, 80)}"` });
        }
        for (const svg of tag.matchAll(/\b(?:fill|stroke|stop-color|flood-color)\s*=\s*["']([^"']*)["']/gi)) {
            chunks.push({ text: svg[1], context: tag.slice(0, 80) });
        }
        const cls = tag.match(/\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
        const clsVal = cls ? (cls[1] ?? cls[2] ?? '') : '';
        for (const arb of clsVal.matchAll(/\[(#[0-9a-fA-F]{3,8})\]/g)) {
            chunks.push({ text: arb[1], context: `class="…${arb[0]}…"` });
        }
    }

    for (const [, attrs, body] of cleaned.matchAll(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi)) {
        if (/data-walkthrough-/.test(attrs)) continue;
        chunks.push({ text: body, context: '<style> block' });
    }
    return chunks;
}

// Returns [{ colour, context }], deduped by canonical rgb, capped at `limit`
// (10 for the reported messages; Infinity when counting for metrics).
function findInventedColours(html, whitelists, limit = 10) {
    const found = [];
    const seen = new Set();
    for (const { text, context } of extractAuthoredColourChunks(html)) {
        for (const token of extractColourTokens(stripUrls(text))) {
            const key = colourKey(token.rgb);
            if (seen.has(key)) continue;
            if (colourAllowed(token.rgb, token.alpha, whitelists)) continue;
            seen.add(key);
            found.push({ colour: token.raw, context });
            if (found.length >= limit) return found;
        }
    }
    return found;
}

function extractHtmlClass(html) {
    const m = html.match(/<html\b[^>]*\bclass\s*=\s*["']([^"']*)["']/i);
    return m ? m[1] : '';
}

function extractBodyClass(html) {
    const m = html.match(/<body\b[^>]*\bclass\s*=\s*["']([^"']*)["']/i);
    return m ? m[1].trim() : null;
}

function extractVisibleText(html) {
    let s = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ');
    s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');
    s = s.replace(/<!--[\s\S]*?-->/g, ' ');
    s = s.replace(/<[^>]+>/g, ' ');
    return s.replace(/\s+/g, ' ').trim();
}

// ─── Article action-target coverage (hard error) ────────────────────────────
// A screenshot of the result cannot teach the reader where the control that
// produced it lives. The article skill records every imperative UI action in a
// top-level action_coverage ledger and marks the real target element in the
// action-ready mockup. The linter independently spots common imperative action
// sentences so omitting the ledger is not a way around the contract.
const ACTION_KINDS = new Set(['click', 'type', 'select', 'toggle', 'drag', 'upload', 'keyboard']);
const UI_ACTION_VERBS = [
    'click', 'select', 'choose', 'press', 'tap', 'open', 'enter', 'type', 'fill(?:\\s+in)?',
    'check', 'uncheck', 'enable', 'disable', 'turn\\s+on', 'turn\\s+off', 'toggle', 'drag',
    'drop', 'upload', 'paste', 'save', 'submit', 'send', 'delete', 'add', 'remove', 'edit',
    'change', 'set', 'configure', 'pause', 'resume', 'stop', 'start', 'go\\s+to', 'navigate\\s+to',
].join('|');
const UI_ACTION_SENTENCE_RE = new RegExp(
    `(?:^|[.!?]\\s+)(?:(?:from|in|on|under|within|at|to begin|when ready|next|then)` +
    `[^.!?]{0,80},\\s*)?(?:${UI_ACTION_VERBS})\\b`, 'i'
);

function articleStepRequiresUiAction(step, articleType) {
    if (articleType === 'concept' || !step || typeof step.content !== 'string') return false;
    // Code is never a UI action: drop fenced blocks and inline spans whole
    // rather than just their backticks, or `start app` in a fence reads as
    // "start" something in the interface.
    const plain = step.content
        .replace(/(^|\n)[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g, '$1')
        .replace(/`[^`\n]*`/g, ' ')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/[*_]/g, '')
        .trim();
    return UI_ACTION_SENTENCE_RE.test(plain);
}

function decodeBasicHtmlEntities(value) {
    return String(value || '')
        .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
        .replace(/&#([0-9]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
        .replace(/&(nbsp|amp|quot|apos|lt|gt);/gi, (_, name) => ({
            nbsp: ' ', amp: '&', quot: '"', apos: "'", lt: '<', gt: '>',
        })[name.toLowerCase()]);
}

function normalizeActionText(value) {
    return decodeBasicHtmlEntities(value).replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function actionMarkerFragments(html, articleStepIndex) {
    const fragments = [];
    const marker = new RegExp(
        `\\bdata-rtfm-action-target\\s*=\\s*["']${articleStepIndex}["']`, 'i'
    );
    const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
        'link', 'meta', 'param', 'source', 'track', 'wbr']);
    for (const match of html.matchAll(/<([a-zA-Z][a-zA-Z0-9:-]*)\b[^>]*>/g)) {
        if (!marker.test(match[0])) continue;
        const tag = match[1].toLowerCase();
        let fragment = match[0];
        if (!voidTags.has(tag)) {
            const close = html.toLowerCase().indexOf(`</${tag}>`, match.index + match[0].length);
            if (close !== -1) fragment = html.slice(match.index, Math.min(close + tag.length + 3, match.index + 4000));
        }
        fragments.push(fragment);
    }
    return fragments;
}

function fragmentShowsActionTarget(fragment, target) {
    const strings = [extractVisibleText(fragment)];
    for (const match of fragment.matchAll(
        /\b(?:aria-label|placeholder|title|alt|value)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi
    )) strings.push(match[1] ?? match[2] ?? '');
    const needle = normalizeActionText(target);
    return Boolean(needle) && strings.some(value => normalizeActionText(value).includes(needle));
}

function evidenceStrings(step) {
    return (step && Array.isArray(step.verbatim_evidence) ? step.verbatim_evidence : [])
        .map(value => (typeof value === 'object' && value !== null ? value.string : value))
        .filter(value => typeof value === 'string');
}

/**
 * Hard screenshot limit for articles: the max_images skill argument, passed to
 * this lint as RTFM_MAX_IMAGES, else 3. Walkthroughs are unaffected (their
 * steps carry no has_image, so action coverage does not run for them).
 */
function maxImages(env = process.env) {
    const value = String(env.RTFM_MAX_IMAGES ?? '').trim();
    return /^[1-9]\d*$/.test(value) ? Number(value) : 3;
}

function lintArticleActionCoverage(vs, article, outputDir, appType, generatedManifest, limit = maxImages()) {
    const errors = [];
    const warnings = [];
    const metrics = { action_coverage: null };
    const articleSteps = Array.isArray(article && article.steps) ? article.steps : [];
    if (!articleSteps.length || !articleSteps.every(step => typeof step.has_image === 'boolean')) {
        return { errors, warnings, metrics };
    }

    const illustrated = new Set(articleSteps.map((step, index) => step.has_image ? index : null)
        .filter(index => index !== null));
    if (illustrated.size > limit) errors.push(
        `article has ${illustrated.size} screenshots; the limit is ${limit} (max_images / RTFM_MAX_IMAGES). ` +
        'Group same-surface actions into one screenshot, keep the main path, and leave conditional steps as text.'
    );
    const sourceSteps = Array.isArray(vs.steps) ? vs.steps : [];
    const sourceByIndex = new Map();
    for (const step of sourceSteps) {
        const index = step && step.index;
        if (!Number.isInteger(index) || index < 0 || index >= articleSteps.length) {
            errors.push(
                `view_sources step index ${JSON.stringify(index)} is outside article.json's zero-based ` +
                `step range 0..${articleSteps.length - 1}`
            );
            continue;
        }
        if (sourceByIndex.has(index)) errors.push(`view_sources.json contains duplicate step index ${index}`);
        sourceByIndex.set(index, step);
        if (!illustrated.has(index)) errors.push(
            `view_sources step ${index} has a mockup, but article.json steps[${index}].has_image is false`
        );
    }
    for (const index of illustrated) {
        if (!sourceByIndex.has(index)) errors.push(
            `article.json steps[${index}].has_image is true, but view_sources.json has no zero-based step ${index}`
        );
    }

    // A standalone external surface cannot be rendered when its image request
    // fails. Permit that article action to remain text-only only with an
    // explicit omission ledger tied to the generator's failure manifest. This
    // exception is deliberately unavailable to ordinary product UI actions.
    const failures = generatedManifest && generatedManifest.failures &&
        typeof generatedManifest.failures === 'object' && !Array.isArray(generatedManifest.failures)
        ? generatedManifest.failures : {};
    const omittedActionSteps = new Set();
    if (vs.generation_omissions !== undefined && !Array.isArray(vs.generation_omissions)) {
        errors.push('view_sources.json generation_omissions must be an array when present');
    }
    for (const omission of (Array.isArray(vs.generation_omissions) ? vs.generation_omissions : [])) {
        const id = omission && typeof omission.asset_id === 'string' ? omission.asset_id : '';
        const indexes = omission && Array.isArray(omission.article_step_indexes)
            ? omission.article_step_indexes : [];
        const failure = failures[id];
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) ||
            typeof omission.reason !== 'string' || !omission.reason.trim() ||
            indexes.length === 0 || indexes.some(index => !Number.isInteger(index))) {
            errors.push('generation_omissions entries require asset_id, article_step_indexes, and reason');
            continue;
        }
        if (!failure || failure.status !== 'failed' || failure.kind !== 'external-surface') {
            errors.push(`generation omission '${id}' must match a failed external-surface request in generated_images.json`);
            continue;
        }
        for (const index of indexes) {
            if (index < 0 || index >= articleSteps.length ||
                !Array.isArray(failure.used_in_steps) || !failure.used_in_steps.includes(index)) {
                errors.push(`generation omission '${id}' has invalid article step index ${index}`);
                continue;
            }
            if (articleSteps[index].has_image !== false || sourceByIndex.has(index)) {
                errors.push(`generation-omitted external step ${index} must be text-only and absent from view_sources.json steps`);
            }
            for (const ext of ['html', 'png']) {
                if (fs.existsSync(path.join(outputDir, `step_${index}.${ext}`))) {
                    errors.push(`generation-omitted external step ${index} must not produce step_${index}.${ext}`);
                }
            }
            omittedActionSteps.add(index);
        }
    }

    // Terminal articles illustrate command/output states, not graphical UI
    // controls, so the action-target marker contract does not apply to them.
    if (appType === 'terminal') return { errors, warnings, metrics };

    const requiredActionSteps = articleSteps.map((step, index) =>
        articleStepRequiresUiAction(step, article.article_type) && !omittedActionSteps.has(index) ? index : null)
        .filter(index => index !== null);
    const coverage = Array.isArray(vs.action_coverage) ? vs.action_coverage : [];
    if (requiredActionSteps.length && !Array.isArray(vs.action_coverage)) {
        errors.push(
            `view_sources.json requires an action_coverage array: imperative UI-action article step(s) ` +
            `${requiredActionSteps.join(', ')} must show their controls in an action-ready screenshot`
        );
    }

    const covered = new Set();
    const seen = new Set();
    for (const entry of coverage) {
        if (!entry || typeof entry !== 'object') {
            errors.push('action_coverage entries must be objects');
            continue;
        }
        const articleIndex = entry.article_step_index;
        const screenshotIndex = entry.screenshot_step_index;
        const target = typeof entry.target === 'string' ? entry.target.trim() : '';
        const identity = `${articleIndex}:${screenshotIndex}:${entry.kind}:${target}`;
        if (seen.has(identity)) errors.push(`action_coverage contains duplicate entry ${identity}`);
        seen.add(identity);
        if (!Number.isInteger(articleIndex) || articleIndex < 0 || articleIndex >= articleSteps.length) {
            errors.push(`action_coverage article_step_index ${JSON.stringify(articleIndex)} is outside the zero-based article step range`);
            continue;
        }
        if (!Number.isInteger(screenshotIndex) || !sourceByIndex.has(screenshotIndex)) {
            errors.push(
                `action_coverage for article step ${articleIndex} points to screenshot_step_index ` +
                `${JSON.stringify(screenshotIndex)}, which is not an illustrated zero-based step`
            );
            continue;
        }
        if (!ACTION_KINDS.has(entry.kind)) errors.push(
            `action_coverage for article step ${articleIndex} has invalid kind ${JSON.stringify(entry.kind)}`
        );
        if (entry.state !== 'action-ready') errors.push(
            `action_coverage for article step ${articleIndex} must use state "action-ready"; ` +
            `post-action/result screenshots cannot replace the control the reader must use`
        );
        if (!target || target.length > 160) errors.push(
            `action_coverage for article step ${articleIndex} requires a concise, non-empty target`
        );

        const screenshotStep = sourceByIndex.get(screenshotIndex);
        const external = screenshotStep && screenshotStep.external_surface;
        if (external) {
            const requiredText = Array.isArray(external.required_text) ? external.required_text : [];
            if (target && !requiredText.some(value => normalizeActionText(value) === normalizeActionText(target))) {
                errors.push(
                    `external screenshot step ${screenshotIndex} does not include action target "${target}" ` +
                    `in external_surface.required_text`
                );
            }
        } else {
            const html = loadFileOrEmpty(path.join(outputDir, `step_${screenshotIndex}.html`));
            const fragments = actionMarkerFragments(html, articleIndex);
            if (!fragments.length) errors.push(
                `step_${screenshotIndex}.html must mark the control for article step ${articleIndex} with ` +
                `data-rtfm-action-target="${articleIndex}"`
            );
            else if (target && !fragments.some(fragment => fragmentShowsActionTarget(fragment, target))) errors.push(
                `step_${screenshotIndex}.html action-target marker for article step ${articleIndex} does not ` +
                `contain visible/accessibility text "${target}"`
            );
            const evidence = evidenceStrings(screenshotStep);
            if (target && !evidence.some(value => normalizeActionText(value) === normalizeActionText(target))) errors.push(
                `step_${screenshotIndex} action target "${target}" must also appear exactly in verbatim_evidence ` +
                `so source grounding and rendered visibility are checked`
            );
        }
        covered.add(articleIndex);
    }
    const missing = requiredActionSteps.filter(index => !covered.has(index));
    // Once the limit is spent, the remaining actions are text-only by design.
    if (missing.length && illustrated.size >= limit) warnings.push(
        `article step(s) ${missing.join(', ')} are text-only: the ${limit}-screenshot limit is reached. ` +
        'Name each control in bold and say where it is.'
    );
    else if (missing.length) errors.push(
        `imperative UI-action article step(s) lack action-ready screenshot coverage: ${missing.join(', ')}. ` +
        'A post-action outcome does not cover the button/input/menu target. ' +
        `${limit - illustrated.size} of ${limit} screenshot(s) remain.`
    );
    if (requiredActionSteps.length) {
        metrics.action_coverage = metricRatio(requiredActionSteps.length - missing.length, requiredActionSteps.length);
    }
    return { errors, warnings, metrics };
}

function loadSourceCorpus(projectDir, sourceFiles) {
    let blob = '';
    for (const rel of sourceFiles) {
        blob += '\n' + loadFileOrEmpty(path.join(projectDir, rel));
    }
    // Also load i18n / locale strings — copy may legitimately come from there.
    const localeDirs = ['config/locales', 'app/javascript/locales', 'lang', 'locales', 'i18n', 'priv/gettext'];
    for (const dir of localeDirs) {
        const abs = path.join(projectDir, dir);
        let entries = [];
        try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { continue; }
        for (const ent of entries) {
            if (ent.isFile() && /\.(ya?ml|json|po|properties)$/i.test(ent.name)) {
                blob += '\n' + loadFileOrEmpty(path.join(abs, ent.name));
            }
        }
    }
    return blob;
}

function findInventedCopy(mockupText, sourceBlob, limit = 10) {
    const sourceLower = sourceBlob.toLowerCase();
    const candidates = mockupText.match(/\b[A-Za-z][A-Za-z'’]+(?:\s+[A-Za-z][A-Za-z'’]+){3,}\b/g) || [];
    const seen = new Set();
    const invented = [];
    for (const phrase of candidates) {
        const norm = phrase.toLowerCase();
        if (seen.has(norm)) continue;
        seen.add(norm);
        if (norm.length < 18) continue;
        const words = norm.split(/\s+/);
        // Allow if ANY 3-word window appears in source
        let matched = false;
        for (let i = 0; i + 3 <= words.length; i++) {
            if (sourceLower.includes(words.slice(i, i + 3).join(' '))) { matched = true; break; }
        }
        if (matched) continue;
        // Allow if >= 70% of content words (>3 letters) appear individually in source
        const content = words.filter(w => w.length > 3);
        if (content.length === 0) continue;
        const present = content.filter(w =>
            new RegExp('\\b' + escapeRegex(w) + '\\b', 'i').test(sourceLower)
        ).length;
        if (present / content.length >= 0.7) continue;
        invented.push(phrase);
        if (invented.length >= limit) break;
    }
    return invented;
}

// Mobile mode renders icons as <i class="f7-icons">name</i> ligatures from the
// vendored framework7-icons font — an invented name silently renders as raw
// text. Validate contents against the bundle's names list; when the bundle
// isn't installed (non-mobile setups) the check is skipped silently.
let f7IconNamesCache;
function loadF7IconNames() {
    if (f7IconNamesCache !== undefined) return f7IconNamesCache;
    const candidates = [
        path.join(__dirname, '..', '..', 'detect-project', 'assets', 'mobileui', 'f7-icons-names.json'),
        path.join(require('os').homedir(), '.rtfm-skills', 'detect-project', 'assets', 'mobileui', 'f7-icons-names.json'),
    ];
    f7IconNamesCache = null;
    for (const p of candidates) {
        try {
            f7IconNamesCache = new Set(JSON.parse(fs.readFileSync(p, 'utf8')));
            break;
        } catch { /* try next */ }
    }
    return f7IconNamesCache;
}

function findInvalidF7Icons(html) {
    if (!html.includes('f7-icons')) return [];
    const names = loadF7IconNames();
    if (!names) return [];
    const bad = new Set();
    const re = /<\w+[^>]*class=["'][^"']*\bf7-icons\b[^"']*["'][^>]*>([^<]*)</g;
    let m;
    while ((m = re.exec(html)) !== null) {
        const name = m[1].trim();
        if (name && !names.has(name)) bad.add(name);
    }
    return [...bad];
}

// ─── Desktop macro-layout bone assembly (hard error) ─────────────────────────
// Deterministic kill for the misassembled-bones failure (meetily / RTFM #511):
// .desktop-app-rows forces flex-direction:column !important, so a sidebar+main
// pair placed directly inside it gives the main pane zero height — every
// screenshot shows chrome next to a blank pane, and because the visible pixels
// are identical across steps the PNGs come out byte-identical. The legal
// assembly is fixed (contract variant B): desktop-pane-fixed/desktop-pane-fill
// ONLY as direct children of .desktop-app-columns, and never a sidebar directly
// under .desktop-app-rows. A tag-stack scan suffices — only direct parentage
// matters. <style>/<script> content is skipped so the inlined branding.css
// (which defines these very classes) can't false-positive. Also reports whether
// any bone class is USED in markup at all, for the need-gate warning (bones on
// a live-JIT project override working CSS — contract variant A forbids them).
const PANE_BONE_RE = /desktop-app-rows|desktop-app-columns|desktop-pane-fixed|desktop-pane-fill/;

function scanPaneBones(html) {
    if (!PANE_BONE_RE.test(html)) return { errors: [], used: false };
    const errors = [];
    let used = false;
    const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img',
        'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
    const stack = [];
    const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
    const lower = html.toLowerCase();
    let m;
    while ((m = tagRe.exec(html)) !== null) {
        const closing = m[1] === '/';
        const tag = m[2].toLowerCase();
        const attrs = m[3] || '';
        if (!closing && (tag === 'style' || tag === 'script')) {
            const end = lower.indexOf(`</${tag}`, tagRe.lastIndex);
            if (end === -1) break;
            tagRe.lastIndex = end;
            continue;
        }
        if (closing) {
            for (let i = stack.length - 1; i >= 0; i--) {
                if (stack[i].tag === tag) { stack.length = i; break; }
            }
            continue;
        }
        const classMatch = attrs.match(/\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
        const classes = new Set(((classMatch && (classMatch[1] || classMatch[2])) || '')
            .split(/\s+/).filter(Boolean));
        if (PANE_BONE_RE.test([...classes].join(' '))) used = true;
        const parent = stack.length ? stack[stack.length - 1] : null;
        const paneClass = classes.has('desktop-pane-fixed') ? 'desktop-pane-fixed'
            : (classes.has('desktop-pane-fill') ? 'desktop-pane-fill' : null);
        if (paneClass && !(parent && parent.classes.has('desktop-app-columns'))) {
            errors.push(
                `.${paneClass} must be a DIRECT child of .desktop-app-columns — found under ` +
                `${parent ? `<${parent.tag} class="${[...parent.classes].join(' ')}">` : 'the document root'}. ` +
                `The macro-layout bones are one fixed assembly (desktop-app-rows > desktop-app-columns > panes); ` +
                `a pane elsewhere renders zero-height/invisible.`
            );
        }
        if (tag === 'aside' && parent && parent.classes.has('desktop-app-rows')) {
            errors.push(
                `<aside> is a direct child of .desktop-app-rows — "rows" stacks its children vertically ` +
                `(flex-direction:column !important), so the sidebar consumes the full height and the main ` +
                `pane renders zero-height/invisible. A sidebar beside its main pane needs ` +
                `.desktop-app-columns (or the app's own row-flex classes) as the shared parent.`
            );
        }
        if (!VOID.has(tag) && !/\/\s*$/.test(attrs)) stack.push({ tag, classes });
    }
    return { errors, used };
}

// ─── CSS-health backstop (check 8, WARN-only) ────────────────────────────────
// Catches a branding.css that is large and valid but does not STYLE the mockup's
// surface (observed: a WordPress bundle missing the separately-enqueued login.css
// — real classes, faithful markup, bare-HTML render, and undefined theme vars
// painting primary buttons white-on-white). Real-but-unstyled classes pass the
// invented-class check BY DESIGN (the containing-chain rule requires copying
// them), so this is a separate, warn-level signal. The detect-side gate
// (detect-project/scripts/check_css_health.js) is the hard enforcement; this
// backstop covers stale caches from before that gate existed.

function stripCssComments(css) {
    return css.replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/url\(\s*(?:'[^']*'|"[^"]*"|[^)]*)\)/gi, 'url()');
}

// Class/id names appearing in selector position, with Tailwind escapes undone.
function buildSelectorNameSets(cssText) {
    const css = stripCssComments(cssText);
    const classes = new Set();
    const ids = new Set();
    for (const m of css.matchAll(/\.((?:[A-Za-z0-9_-]|\\[^\s])+)/g)) classes.add(m[1].replace(/\\(.)/g, '$1'));
    for (const m of css.matchAll(/#((?:[A-Za-z0-9_-]|\\[^\s])+)/g)) ids.add(m[1].replace(/\\(.)/g, '$1'));
    return { classes, ids };
}

function extractStyleBlocks(html) {
    let out = '';
    for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) out += m[1] + '\n';
    return out;
}

function findUndefinedCssVars(cssText) {
    const css = stripCssComments(cssText);
    const defined = new Set();
    for (const m of css.matchAll(/(?:^|[{;\s])(--[A-Za-z0-9_-]+)\s*:/g)) defined.add(m[1]);
    for (const m of css.matchAll(/@property\s+(--[A-Za-z0-9_-]+)/g)) defined.add(m[1]);
    // Only var() inside CONCRETE declarations counts — a var() inside another
    // custom property's value resolves lazily and is often intentionally
    // undefined (Tailwind v3's --tw-shadow-colored idiom).
    const noFallback = new Map();
    for (const d of css.matchAll(/(?:^|[{;])\s*([A-Za-z-][A-Za-z0-9_-]*)\s*:\s*([^;{}]*)/g)) {
        if (d[1].startsWith('--')) continue;
        for (const m of d[2].matchAll(/var\(\s*(--[A-Za-z0-9_-]+)\s*\)/g)) {
            noFallback.set(m[1], (noFallback.get(m[1]) || 0) + 1);
        }
    }
    return [...noFallback.entries()]
        .filter(([name, uses]) => !defined.has(name) && uses >= 3)
        .sort((a, b) => b[1] - a[1]);
}

function styledCoverage(html, selectorSets) {
    // The mockup's own <style> blocks legitimately style its classes too.
    const own = buildSelectorNameSets(extractStyleBlocks(html));
    const tokens = new Set();
    const idTokens = new Set();
    for (const m of html.matchAll(/\bclass\s*=\s*(["'])([\s\S]*?)\1/gi)) {
        for (const t of m[2].split(/\s+/)) {
            if (t && t.length <= 64 && /^-?[A-Za-z_]/.test(t)) tokens.add(t);
        }
    }
    for (const m of html.matchAll(/\bid\s*=\s*(["'])([^"']*)\1/gi)) {
        if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(m[2])) idTokens.add(m[2]);
    }
    const unmatched = [];
    let matched = 0;
    for (const c of tokens) {
        if (selectorSets.classes.has(c) || own.classes.has(c)) matched++;
        else unmatched.push('.' + c);
    }
    for (const i of idTokens) {
        if (selectorSets.ids.has(i) || own.ids.has(i)) matched++;
        else unmatched.push('#' + i);
    }
    return { total: tokens.size + idTokens.size, matched, unmatched };
}

// ─── Walkthrough interaction wiring (check 7) ────────────────────────────────
// The recorder blindly trusts these attributes and targets the FIRST
// data-walkthrough-action="advance" match — a missing, duplicated, or
// mis-placed trigger makes the cursor move to and click the wrong element.
// Typing only fires on a real <input>/<textarea> that carries type-text.
// Nothing else validates any of this, so assert it before spending Puppeteer
// time recording a broken interaction.
function lintWalkthroughWiring(step, html, isLast, nextIndex, narrationText) {
    const errors = [];
    const warnings = [];

    // Fresh literals each call so there is no shared regex lastIndex state.
    const advanceCount = (html.match(
        /<[a-zA-Z][^>]*\bdata-walkthrough-action\s*=\s*["']advance["'][^>]*>/gi
    ) || []).length;

    if (isLast) {
        if (advanceCount > 0) {
            errors.push(
                `step_${step.index}.html is the final step but carries ${advanceCount} ` +
                `data-walkthrough-action="advance" element(s); the last step must have none ` +
                `(there is no next step to navigate to).`
            );
        }
    } else if (advanceCount === 0) {
        errors.push(
            `step_${step.index}.html has no data-walkthrough-action="advance" element. Every ` +
            `non-final step needs exactly one — without it the recorder has nothing to click to ` +
            `reach step_${nextIndex}.html.`
        );
    } else if (advanceCount > 1) {
        errors.push(
            `step_${step.index}.html has ${advanceCount} data-walkthrough-action="advance" ` +
            `elements. The recorder moves to and clicks only the FIRST match, so the cursor can ` +
            `land on the wrong element. Keep exactly one advance trigger and remove the rest.`
        );
    } else if (!html.includes(`step_${nextIndex}.html`)) {
        warnings.push(
            `step_${step.index}.html advance trigger does not reference step_${nextIndex}.html — ` +
            `it should be or contain <a href="step_${nextIndex}.html"> per the mockup contract.`
        );
    }

    // Typing fields must be a real <input>/<textarea>, carry non-empty
    // type-text, and use unique positive-integer fill orders.
    const orderCounts = new Map();
    for (const m of html.matchAll(
        /<([a-zA-Z][\w-]*)\b([^>]*\bdata-walkthrough-type-into\s*=\s*["'][^"']*["'][^>]*)>/gi
    )) {
        const tag = m[1].toLowerCase();
        const attrs = m[2];
        if (tag !== 'input' && tag !== 'textarea') {
            errors.push(
                `step_${step.index}.html puts data-walkthrough-type-into on <${tag}> — the ` +
                `recorder only types into <input>/<textarea> and silently skips everything else, ` +
                `so this field is never filled. Move the attribute onto the real input.`
            );
            continue;
        }
        const textMatch = attrs.match(/\bdata-walkthrough-type-text\s*=\s*["']([^"']*)["']/i);
        if (!textMatch || !textMatch[1].trim()) {
            errors.push(
                `step_${step.index}.html has a data-walkthrough-type-into <${tag}> with no ` +
                `(non-empty) data-walkthrough-type-text — the cursor moves there but types nothing.`
            );
        }
        const orderRaw = (attrs.match(/\bdata-walkthrough-type-into\s*=\s*["']([^"']*)["']/i)?.[1] || '').trim();
        const orderNum = parseInt(orderRaw, 10);
        if (!Number.isInteger(orderNum) || orderNum < 1 || String(orderNum) !== orderRaw) {
            warnings.push(
                `step_${step.index}.html data-walkthrough-type-into="${orderRaw}" is not a positive ` +
                `integer; fill order falls back to DOM order.`
            );
        } else {
            orderCounts.set(orderNum, (orderCounts.get(orderNum) || 0) + 1);
        }
    }
    for (const [order, count] of orderCounts) {
        if (count > 1) {
            warnings.push(
                `step_${step.index}.html has ${count} fields sharing data-walkthrough-type-into=` +
                `"${order}"; ties are broken by DOM order, which may fill them out of sequence.`
            );
        }
    }

    // Pre-actions: data-walkthrough-do must be a kind the recorder handles;
    // data-walkthrough-order (if set) a positive integer; a native <select>
    // select needs a value to know which option to choose.
    const VALID_DO = new Set(['scroll-to', 'hover', 'click', 'select', 'check', 'swipe']);
    const SWIPE_DIRS = new Set(['up', 'down', 'left', 'right']);
    const preOrderCounts = new Map();
    const presentKinds = new Set();   // kinds actually authored on this step (for the narration check)
    for (const m of html.matchAll(
        /<([a-zA-Z][\w-]*)\b([^>]*\bdata-walkthrough-do\s*=\s*["']([^"']*)["'][^>]*)>/gi
    )) {
        const tag = m[1].toLowerCase();
        const attrs = m[2];
        const kind = (m[3] || '').trim().toLowerCase();
        if (VALID_DO.has(kind)) presentKinds.add(kind);
        if (!VALID_DO.has(kind)) {
            errors.push(
                `step_${step.index}.html has data-walkthrough-do="${kind}", which the recorder does not ` +
                `understand — it is skipped, so the interaction never happens. Use one of: ${[...VALID_DO].join(', ')}.`
            );
            continue;
        }
        const orderRaw = (attrs.match(/\bdata-walkthrough-order\s*=\s*["']([^"']*)["']/i)?.[1] || '').trim();
        if (orderRaw) {
            const n = parseInt(orderRaw, 10);
            if (!Number.isInteger(n) || n < 1 || String(n) !== orderRaw) {
                warnings.push(
                    `step_${step.index}.html data-walkthrough-order="${orderRaw}" (on a "${kind}" action) is not a ` +
                    `positive integer; pre-action order falls back to DOM order.`
                );
            } else {
                preOrderCounts.set(n, (preOrderCounts.get(n) || 0) + 1);
            }
        }
        const valueMatch = attrs.match(/\bdata-walkthrough-value\s*=\s*["']([^"']*)["']/i);
        const hasValue = !!valueMatch;
        if (kind === 'select' && tag === 'select' && !hasValue) {
            warnings.push(
                `step_${step.index}.html has data-walkthrough-do="select" on a native <select> with no ` +
                `data-walkthrough-value — the recorder won't know which option to choose.`
            );
        }
        if (kind === 'swipe') {
            const dir = (valueMatch?.[1] || '').trim().toLowerCase();
            if (!SWIPE_DIRS.has(dir)) {
                warnings.push(
                    `step_${step.index}.html has data-walkthrough-do="swipe" with data-walkthrough-value=` +
                    `"${dir}" — expected one of up/down/left/right; the recorder defaults to "up".`
                );
            }
        }
    }
    for (const [order, count] of preOrderCounts) {
        if (count > 1) {
            warnings.push(
                `step_${step.index}.html has ${count} pre-actions sharing data-walkthrough-order="${order}"; ` +
                `ties break by DOM order, which may run them out of sequence.`
            );
        }
    }

    // Narration ↔ interaction consistency. If the step's spoken narration promises an
    // interaction (scroll / open a menu / hover / select from a dropdown / toggle) but the
    // mockup has no matching data-walkthrough-do, the video never performs it — a fidelity
    // miss. Heuristic verb-matching, so WARN (not error): false positives shouldn't fail a
    // run, and the contract does the heavy lifting. "click" is excluded (that's the advance).
    const narr = (narrationText || '').toLowerCase();
    if (narr) {
        const wants = [
            { re: /\bscroll(s|ing|ed)?\b/,                                         kinds: ['scroll-to', 'swipe'], label: 'scrolling' },
            { re: /\bswip(e|es|ing|ed)\b/,                                         kinds: ['swipe', 'scroll-to'], label: 'swiping' },
            { re: /\b(open|expand|reveal)(s|ing|ed)?\b[^.]*\b(menu|dropdown|drop-down|list|panel|options|picker|actions?)\b/, kinds: ['hover', 'click'], label: 'opening a menu/dropdown' },
            { re: /\bhover(s|ing|ed)?\b/,                                          kinds: ['hover'],           label: 'hovering' },
            { re: /\b(toggle|tick|untick|switch on|switch off|turn on|turn off|enable|disable)(s|d|ing)?\b/, kinds: ['check', 'click'], label: 'toggling a control' },
            { re: /\b(select|choose|pick)(s|ing)?\b[^.]*\b(from|dropdown|drop-down|option|menu|list)\b/,      kinds: ['select', 'click'], label: 'selecting from a dropdown' },
        ];
        for (const w of wants) {
            if (w.re.test(narr) && !w.kinds.some(k => presentKinds.has(k))) {
                warnings.push(
                    `step_${step.index} narration describes ${w.label} but the mockup has no matching ` +
                    `data-walkthrough-do (${w.kinds.join('/')}) — the video won't perform it. Author the ` +
                    `pre-action, or drop the phrase from the narration.`
                );
            }
        }
    }

    return { errors, warnings };
}

function lintGeneratedContent(step, html, sourceHtml, generatedManifest) {
    const errors = [];
    const markers = dataAttrTags(html, 'data-rtfm-generated-asset');
    const source = sourceHtml || html;
    const assets = generatedManifest && generatedManifest.assets && typeof generatedManifest.assets === 'object'
        ? generatedManifest.assets : {};
    const externalLedger = step.external_surface;

    if (externalLedger) {
        if (!externalLedger || typeof externalLedger !== 'object' ||
            typeof externalLedger.asset_id !== 'string' || !EXTERNAL_SURFACES.has(externalLedger.surface) ||
            !EXTERNAL_SOURCE_BASES.has(externalLedger.source_basis) ||
            !Array.isArray(externalLedger.source_files) ||
            externalLedger.source_files.some(source => !isSafeProjectRelativePath(source)) ||
            !Array.isArray(externalLedger.required_text) || externalLedger.required_text.length === 0 ||
            externalLedger.required_text.length > 20 || externalLedger.required_text.some(text =>
                typeof text !== 'string' || !text.trim() || text.length > 500) ||
            new Set(externalLedger.required_text).size !== externalLedger.required_text.length) {
            errors.push('view_sources.json external_surface requires asset_id, a valid surface/source_basis, source_files, and required_text');
        }
        if (step.url_or_route !== `external:${externalLedger.surface}`) {
            errors.push(`external_surface step url_or_route must be "external:${externalLedger.surface}"`);
        }
        if (step.primary_view || step.layout ||
            (Array.isArray(step.partials_expanded) && step.partials_expanded.length) ||
            step.runtime_state_id || (Array.isArray(step.runtime_source_files) && step.runtime_source_files.length)) {
            errors.push('external_surface steps must omit product primary_view, layout, partials, and runtime-state fields');
        }
    }

    for (const marker of markers) {
        const id = marker.value;
        if (!/^<img\b/i.test(marker.tag)) {
            errors.push(`generated content asset '${id}' must appear on an <img> element only; generated pixels may never replace mockup UI or chrome`);
            continue;
        }
        if (!Object.hasOwn(assets, id)) {
            errors.push(`generated content asset '${id}' is not declared in generated_images.json`);
            continue;
        }
        const entry = assets[id];
        const isExternal = entry.kind === 'external-surface';
        if (!Array.isArray(entry.used_in_steps) || !entry.used_in_steps.includes(step.index)) {
            errors.push(`generated content asset '${id}' does not declare step ${step.index} in used_in_steps`);
        }
        const src = marker.tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
        const unresolvedAfterInjection = Boolean(sourceHtml) && src && src[1] === `{{generated:${id}}}`;
        if (!src || unresolvedAfterInjection ||
            (!src[1].startsWith('data:image/') && src[1] !== `{{generated:${id}}}`)) {
            errors.push(`generated content asset '${id}' must use src="{{generated:${id}}}" (or its injected image data URI)`);
        }
        if (!isExternal && (/\b(?:data-rtfm-region|data-rtfm-placement|data-walkthrough-stage)\s*=/i.test(marker.tag) ||
            /\bstyle\s*=\s*["'][^"']*(?:position\s*:\s*fixed|(?:width|height)\s*:\s*100v[wh]|inset\s*:\s*0)/i.test(marker.tag))) {
            errors.push(`generated content asset '${id}' is attached to a screen/region-sized element; generated pixels must remain leaf content inside the source-grounded mockup`);
        }
        const externalAttr = marker.tag.match(/\bdata-rtfm-external-surface\s*=\s*["']([^"']+)["']/i);
        if (isExternal) {
            if (!externalLedger || externalLedger.asset_id !== id || externalLedger.surface !== entry.surface ||
                externalLedger.source_basis !== entry.source_basis ||
                !sameStringArray(externalLedger.required_text, entry.required_text) ||
                !sameStringArray(externalLedger.source_files, entry.source_files)) {
                errors.push(`external surface asset '${id}' does not exactly match its view_sources.json external_surface ledger`);
            }
            if (!externalAttr || externalAttr[1] !== entry.surface) {
                errors.push(`external surface asset '${id}' must declare data-rtfm-external-surface="${entry.surface}" on its <img>`);
            }
            if (!/<body\b[^>]*\bdata-rtfm-surface\s*=\s*["']external["']/i.test(source)) {
                errors.push(`external surface asset '${id}' requires data-rtfm-surface="external" on <body>`);
            }
            if (/\bdata-rtfm-(?:region|state)\s*=/i.test(source)) {
                errors.push(`external surface asset '${id}' must be a standalone external step, not embedded in product UI regions or states`);
            }
        } else if (externalAttr) {
            errors.push(`generated content asset '${id}' may not declare data-rtfm-external-surface; that marker is reserved for kind external-surface`);
        }
    }

    const externalMarkers = markers.filter(marker => {
        const entry = assets[marker.value];
        return entry && entry.kind === 'external-surface';
    });
    if (externalMarkers.length > 1) {
        errors.push('a step may contain at most one generated external surface');
    }
    if (externalLedger && (externalMarkers.length !== 1 || markers.length !== 1)) {
        errors.push('a view_sources.json external_surface step must contain exactly one generated asset: its matching external surface');
    }

    const sourceTags = [...source.matchAll(/<img\b[^>]*>/gi)].map(match => match[0]);
    for (const tag of sourceTags) {
        const token = tag.match(/\bsrc\s*=\s*["']\{\{generated:([a-z0-9]+(?:-[a-z0-9]+)*)\}\}["']/i);
        const marker = tag.match(/\bdata-rtfm-generated-asset\s*=\s*["']([^"']+)["']/i);
        if (token && (!marker || token[1] !== marker[1])) errors.push(
            `{{generated:${token[1]}}} must be the src of an <img> carrying the matching data-rtfm-generated-asset marker`
        );
    }
    let stripped = source;
    for (const tag of sourceTags) stripped = stripped.replace(tag, '');
    if (/\{\{generated:[^}]+\}\}/.test(stripped)) {
        errors.push('generated image tokens may only appear as <img src> values; CSS backgrounds and mockup-wide generated surfaces are forbidden');
    }

    for (const [id, entry] of Object.entries(assets)) {
        if (Array.isArray(entry.used_in_steps) && entry.used_in_steps.includes(step.index)
            && !markers.some(marker => marker.value === id)) {
            errors.push(`generated_images.json assigns '${id}' to step ${step.index}, but the mockup has no matching <img> marker`);
        }
    }
    return errors;
}

function lintStep(step, outputDir, projectDir, brandingCss, colourWhitelist, walkthrough, selectorSets,
    generatedManifest) {
    const errors = [];
    const warnings = [];
    const metrics = emptyStepMetrics();
    const stepHtmlPath = path.join(outputDir, step.file || `step_${step.index}.html`);
    const html = loadFileOrEmpty(stepHtmlPath);
    if (!html) {
        errors.push(`mockup file not found: step_${step.index}.html`);
        return { errors, warnings, metrics };
    }

    const preInjectionHtml = loadFileOrEmpty(stepHtmlPath + '.pre');
    errors.push(...lintGeneratedContent(step, html, preInjectionHtml, generatedManifest));

    const externalLedger = step.external_surface;
    const primary = step.primary_view;
    const partials = Array.isArray(step.partials_expanded) ? step.partials_expanded : [];
    const externalSources = externalLedger && Array.isArray(externalLedger.source_files)
        ? externalLedger.source_files : [];
    const allSources = [primary, ...partials, step.layout, ...externalSources].filter(Boolean);

    // 1. Source-view existence
    if (externalLedger) {
        for (const source of externalSources) {
            if (!isSafeProjectRelativePath(source)) {
                errors.push(`external_surface source file must be a safe project-relative path: ${source}`);
            } else if (!sourceExists(projectDir, source)) {
                errors.push(`external_surface source file does not exist in project: ${source}`);
            }
        }
    } else if (!primary) {
        errors.push('view_sources.json: missing primary_view');
    } else if (!fs.existsSync(path.join(projectDir, primary))) {
        errors.push(`primary_view does not exist in project: ${primary}`);
    }
    let partialsPresent = 0;
    for (const partial of partials) {
        if (!fs.existsSync(path.join(projectDir, partial))) {
            warnings.push(`partial listed but file missing: ${partial}`);
        } else {
            partialsPresent++;
        }
    }
    if (partials.length) metrics.partials_present = metricRatio(partialsPresent, partials.length);

    // 2. Invented-class check
    const inlineClasses = extractInlineStyleClassSelectors(html);
    let inlineVerified = 0;
    for (const cls of inlineClasses) {
        if (classDefinedInBranding(brandingCss, cls) || classMentionedInProject(projectDir, allSources, cls)) {
            inlineVerified++;
            continue;
        }
        errors.push(
            `step_${step.index}.html defines .${cls} inline but the class is absent from ` +
            `primary_view, partials, layout, and branding.css. Either expand the missing ` +
            `partial in partials_expanded, or remove the invented component and rebuild ` +
            `from the real one in ${primary || '<unknown>'}.`
        );
    }
    if (inlineClasses.length) metrics.inline_classes_verified = metricRatio(inlineVerified, inlineClasses.length);

    // 2b. Emoji-as-icon check
    const emojiIcons = findEmojiIcons(html);
    if (emojiIcons.length) {
        const shown = emojiIcons.slice(0, 8).join(' ') + (emojiIcons.length > 8 ? ' …' : '');
        errors.push(
            `step_${step.index}.html uses emoji/pictographic glyphs as icons (${shown}). Real UIs ` +
            `use SVG or icon-font icons — replace each with an inline <svg> copied from the source's ` +
            `icon markup (or the project's icon system); never an emoji or its HTML entity.`
        );
    }

    // 2c. f7-icons ligature check (mobile mode)
    const invalidF7 = findInvalidF7Icons(html);
    if (invalidF7.length) {
        errors.push(
            `step_${step.index}.html uses f7-icons ligature name(s) that don't exist in the vendored ` +
            `icon font (${invalidF7.join(', ')}) — they would render as raw text. Pick real names from ` +
            `detect-project/assets/mobileui/f7-icons-names.json (e.g. gear, house_fill, chevron_right).`
        );
    }

    // 3. Verbatim-string check (positive)
    const evidence = Array.isArray(step.verbatim_evidence) ? step.verbatim_evidence : [];
    if (primary && evidence.length < 3) {
        warnings.push(
            `fewer than 3 verbatim_evidence entries (got ${evidence.length}) — model may not have read primary_view`
        );
    }
    let evSrcTotal = 0, evSrcHits = 0, evHtmlTotal = 0, evHtmlHits = 0;
    for (const e of evidence) {
        const str = typeof e === 'string' ? e : e.string;
        const src = (typeof e === 'object' && e.found_in) || primary;
        if (!str) continue;
        if (src || (e && e.generated)) {
            evSrcTotal++;
            const verified = verifyLabelEvidence(e, primary, projectDir);
            if (!verified.ok) {
                errors.push(verified.error);
            } else {
                evSrcHits++;
            }
        }
        evHtmlTotal++;
        if (!html.includes(str)) {
            errors.push(
                `verbatim_evidence "${str}" missing from step_${step.index}.html ` +
                `(must appear in the mockup as proof it was sourced from real templates)`
            );
        } else {
            evHtmlHits++;
        }
    }
    if (evSrcTotal) metrics.verbatim_evidence_source = metricRatio(evSrcHits, evSrcTotal);
    if (evHtmlTotal) metrics.verbatim_evidence_html = metricRatio(evHtmlHits, evHtmlTotal);

    // 3b. Invented-copy negative check (warning only). The message keeps its
    // 10-entry cap (`invented`); the metric counts the uncapped list.
    const sourceBlob = loadSourceCorpus(projectDir, allSources);
    const mockupText = extractVisibleText(html);
    const inventedAll = findInventedCopy(mockupText, sourceBlob, Infinity);
    const invented = inventedAll.slice(0, 10);
    metrics.invented_copy = { count: inventedAll.length };
    if (invented.length > 0) {
        warnings.push(
            `${invented.length} multi-word phrase(s) in step_${step.index}.html do not appear ` +
            `in any listed source file or locale: ` +
            invented.slice(0, 3).map(s => `"${s}"`).join(', ') +
            (invented.length > 3 ? ', …' : '')
        );
    }

    // 2b. Invented-colour check — colours in inline styles / authored <style>
    // blocks / SVG fills must exist in branding.css or this step's sources.
    const stepColours = buildColourWhitelist(sourceBlob);
    const inventedColoursAll = findInventedColours(html, [colourWhitelist, stepColours], Infinity);
    metrics.invented_colours = { count: inventedColoursAll.length };
    for (const { colour, context } of inventedColoursAll.slice(0, 10)) {
        errors.push(
            `step_${step.index}.html uses colour ${colour} (${context}) that appears nowhere ` +
            `in branding.css or this step's source files. Do not invent a palette — copy ` +
            `colour values from the step's real templates, or style the element with an ` +
            `existing class from branding.css.`
        );
    }

    // 4. Default-user-assumption check
    const assumptions = Array.isArray(step.default_user_assumptions) ? step.default_user_assumptions : [];
    for (const a of assumptions) {
        const text = typeof a === 'string' ? a : a.text;
        const checks = (typeof a === 'object' && Array.isArray(a.markup_absence_check)) ? a.markup_absence_check : [];
        for (const needle of checks) {
            if (html.includes(needle)) {
                errors.push(
                    `default_user_assumption "${text || a}" says the mockup should not render ` +
                    `"${needle}", but it appears in step_${step.index}.html. ` +
                    `Remove that region or revise the assumption.`
                );
            }
        }
    }

    // 5. Body-class check
    if (step.layout) {
        const layoutText = loadFileOrEmpty(path.join(projectDir, step.layout));
        const layoutBodyMatch = layoutText.match(/<body\b[^>]*\bclass\s*=\s*["']([^"']*)["']/i);
        if (layoutBodyMatch) {
            const layoutTokens = layoutBodyMatch[1].split(/\s+/).filter(Boolean);
            const expected = layoutTokens.filter(t =>
                !t.includes('<%') && !t.includes('%>') && !t.includes('{{') && !t.includes('}}') && !t.includes('${')
            );
            const mockupBodyClass = extractBodyClass(html) || '';
            const mockupTokens = new Set(mockupBodyClass.split(/\s+/).filter(Boolean));
            const missing = expected.filter(t => !mockupTokens.has(t));
            if (expected.length) metrics.body_class_tokens = metricRatio(expected.length - missing.length, expected.length);
            if (missing.length > 0) {
                errors.push(
                    `<body> class mismatch in step_${step.index}.html: layout (${step.layout}) ` +
                    `defines body class="${layoutBodyMatch[1]}" but mockup is missing token(s): ` +
                    missing.join(', ')
                );
            }
        }
    }

    // 6b. Screen-closure check (WARN only, data-gated): the screen IS the
    //     primary view plus everything it renders unconditionally. A mockup of
    //     that view must carry a trace of each unconditional include and each
    //     inline section the view paints — dropping one is the primary-view
    //     analogue of dropping a layout chrome file. Overlays (modals/drawers/
    //     menus) and guarded includes are exempt: overlays open only when a step
    //     opens them, guards resolve per default_user_assumptions. A piece with
    //     no usable marker strings is not checkable and is skipped; a block whose
    //     primary_view is itself an overlay (a modal step) is exempt. Warn-only:
    //     the census is regex-derived and a marker can legitimately live in an
    //     i18n key the census cannot resolve.
    if (primary && !externalLedger && fs.existsSync(path.join(projectDir, primary))
        && !includeCensus.OVERLAY_NAME_RE.test(path.basename(primary))) {
        const cen = includeCensus.census(projectDir, primary);
        const mockupLower = html.toLowerCase();
        const has = s => mockupLower.includes(String(s).toLowerCase());
        const pieces = [];
        for (const inc of cen.includes) {
            if (inc.kind !== 'unconditional' || !inc.markers.length) continue;
            pieces.push({ label: `${inc.name}${inc.file ? ` (${inc.file})` : ''}`, markers: inc.markers });
        }
        for (const sec of cen.inline_sections) {
            if (sec.guarded || !sec.markers.length) continue;
            pieces.push({ label: `inline section "${sec.heading}"`, markers: sec.markers });
        }
        if (pieces.length) {
            const missing = pieces.filter(p => !p.markers.some(has));
            metrics.screen_closure = metricRatio(pieces.length - missing.length, pieces.length);
            if (missing.length) {
                warnings.push(
                    `step_${step.index}.html omits ${missing.length}/${pieces.length} piece(s) the primary view ` +
                    `${primary} renders unconditionally: ${missing.map(p => `${p.label} [e.g. ${p.markers.slice(0, 2).map(s => JSON.stringify(s)).join(', ')}]`).join('; ')}. ` +
                    `The screen is the primary view plus every unconditional include and inline section — render all of them ` +
                    `on every screenshot of this view (overlays open over it; guarded pieces follow default_user_assumptions).`
                );
            }
        }
    }

    // 8. Styled-coverage backstop (WARN only). Low coverage means the branding
    //    bundle likely misses the stylesheet(s) that style THIS surface — the
    //    render will be structurally faithful but visually bare.
    if (selectorSets) {
        const cov = styledCoverage(html, selectorSets);
        if (cov.total) metrics.styled_coverage = metricRatio(cov.matched, cov.total);
        if (cov.total >= 10 && cov.matched / cov.total < 0.5) {
            const pct = Math.round((cov.matched / cov.total) * 100);
            const sample = cov.unmatched.slice(0, 8).join(', ') + (cov.unmatched.length > 8 ? ', …' : '');
            warnings.push(
                `only ${cov.matched}/${cov.total} (${pct}%) of this mockup's class/id tokens match a ` +
                `selector in branding.css/mockup.css (unmatched: ${sample}). The branding bundle ` +
                `probably misses the stylesheet(s) for this surface (per-page/per-area CSS the main ` +
                `bundle never imports) — expect an unstyled render. Re-run /detect-project to repair ` +
                `the cache. (May be a false alarm if this project styles via a CDN at render time.)`
            );
        }
    }

    // 7. Walkthrough interaction wiring (walkthrough runs only — gated on
    //    actions.json existing, see main()). Articles pass walkthrough=null.
    if (walkthrough) {
        const isLast = step.index === walkthrough.lastIndex;
        const narrationText = walkthrough.narrationByIndex && walkthrough.narrationByIndex[step.index];
        const { errors: wErrors, warnings: wWarnings } =
            lintWalkthroughWiring(step, html, isLast, step.index + 1, narrationText);
        errors.push(...wErrors);
        warnings.push(...wWarnings);
    }

    return { errors, warnings, metrics };
}

function main() {
    const outputDir = process.argv[2];
    const projectDir = process.argv[3] || process.cwd();
    if (!outputDir) {
        console.error('Usage: lint_mockup_fidelity.js <output_dir> [<project_dir>]');
        process.exit(2);
    }
    const vsPath = path.join(outputDir, 'view_sources.json');
    if (!fs.existsSync(vsPath)) {
        console.error(`Missing view_sources.json at ${vsPath}.`);
        console.error('The skill must produce this artefact before lint can run.');
        process.exit(2);
    }
    let vs;
    try {
        vs = JSON.parse(fs.readFileSync(vsPath, 'utf8'));
    } catch (e) {
        console.error(`view_sources.json is not valid JSON: ${e.message}`);
        process.exit(2);
    }
    // Schema-v2 articles key source evidence and files by stable block id. The
    // fidelity engine predates that contract and is intentionally kept shared
    // with step-based walkthroughs, so adapt blocks to its internal indexed
    // representation and create short-lived file aliases for this process.
    const blockMode = Array.isArray(vs.blocks);
    let blockIndex = null;
    const temporaryAliases = [];
    const orphanBlocks = [];
    if (blockMode) {
        // Number each block by its section's position in article.json, the positions
        // the article-side checks use. view_sources lists only the illustrated sections,
        // so its own order agrees only when those come first. Every section is numbered,
        // not just illustrated ones: action coverage may name a text-only section. With
        // no article sections (walkthroughs), view_sources order is the step order.
        let sections = [];
        try {
            const article = JSON.parse(fs.readFileSync(path.join(outputDir, 'article.json'), 'utf8'));
            if (Array.isArray(article.blocks)) sections = article.blocks.filter(block => block && block.type === 'section');
        } catch (_) { /* Missing or invalid article.json is reported by the article check. */ }
        blockIndex = new Map();
        if (sections.length) {
            sections.forEach((block, index) => blockIndex.set(block.id, index));
            // A block naming no section still gets a distinct number, so the other checks
            // can run; the mismatch is reported once, by name.
            vs.blocks.forEach(entry => {
                if (blockIndex.has(entry.block_id)) return;
                orphanBlocks.push(entry.block_id);
                blockIndex.set(entry.block_id, sections.length + orphanBlocks.length - 1);
            });
        } else vs.blocks.forEach((entry, index) => blockIndex.set(entry.block_id, index));
        vs.steps = vs.blocks.map(entry => {
            const index = blockIndex.get(entry.block_id);
            for (const extension of ['html', 'png']) {
                const source = path.join(outputDir, `block_${entry.block_id}.${extension}`);
                const alias = path.join(outputDir, `step_${index}.${extension}`);
                if (fs.existsSync(source) && !fs.existsSync(alias)) {
                    if (extension === 'html') {
                        let contents = fs.readFileSync(source, 'utf8');
                        for (const [blockId, blockPosition] of blockIndex) {
                            contents = contents.replaceAll(`data-rtfm-action-target="${blockId}"`, `data-rtfm-action-target="${blockPosition}"`);
                            contents = contents.replaceAll(`data-rtfm-action-target='${blockId}'`, `data-rtfm-action-target='${blockPosition}'`);
                        }
                        fs.writeFileSync(alias, contents);
                    } else fs.copyFileSync(source, alias);
                    temporaryAliases.push(alias);
                }
            }
            return { ...entry, index, file: `block_${entry.block_id}.html` };
        });
        vs.action_coverage = (vs.action_coverage || []).map(entry => ({
            ...entry,
            article_step_index: entry.article_step_index ?? blockIndex.get(entry.article_block_id),
            screenshot_step_index: entry.screenshot_step_index ?? blockIndex.get(entry.screenshot_block_id),
        }));
        vs.generation_omissions = (vs.generation_omissions || []).map(entry => ({
            ...entry,
            article_step_indexes: entry.article_step_indexes || (entry.article_block_ids || []).map(id => blockIndex.get(id)),
        }));
        process.on('exit', () => temporaryAliases.forEach(file => { try { fs.unlinkSync(file); } catch {} }));
    }
    const brandingCss = loadFileOrEmpty(path.join(outputDir, 'branding.css'));
    // Built once per run — branding.css can be 2MB+ of compiled CSS.
    const colourWhitelist = buildColourWhitelist(brandingCss);

    // Check-8 corpus: branding.css plus the JIT output when it ran (lint runs
    // after inject, so mockup.css sits next to the steps for Tailwind projects).
    const mockupCss = loadFileOrEmpty(path.join(outputDir, 'mockup.css'));
    const selectorSets = brandingCss ? buildSelectorNameSets(brandingCss + '\n' + mockupCss) : null;

    const report = {
        framework: vs.framework || null,
        project_dir: projectDir,
        global_errors: [],
        global_warnings: [],
        steps: [],
        all_passed: true,
        metrics: null,
    };
    for (const id of orphanBlocks) {
        report.global_errors.push(`view_sources.json block '${id}' names no section in article.json; use the illustrated section's id as block_id`);
    }

    let generatedManifest = null;
    const generatedPath = path.join(outputDir, 'generated_images.json');
    if (fs.existsSync(generatedPath)) {
        try {
            generatedManifest = JSON.parse(fs.readFileSync(generatedPath, 'utf8'));
            if (blockMode) {
                for (const collection of ['assets', 'failures']) {
                    for (const entry of Object.values(generatedManifest[collection] || {})) {
                        if (entry && Array.isArray(entry.used_in_blocks) && !Array.isArray(entry.used_in_steps)) {
                            entry.used_in_steps = entry.used_in_blocks.map(id => blockIndex.get(id));
                        }
                    }
                }
            }
            const assets = generatedManifest.assets;
            const entries = assets && typeof assets === 'object' && !Array.isArray(assets)
                ? Object.entries(assets) : [];
            if (generatedManifest.version !== 1 || entries.length > 5 ||
                generatedManifest.count !== entries.length || generatedManifest.max_assets !== 5) {
                report.global_errors.push('generated_images.json must use version 1 and contain at most 5 assets');
            }
            for (const [id, entry] of entries) {
                if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || !entry ||
                    !GENERATED_KINDS.has(entry.kind) || typeof entry.reason !== 'string' || !entry.reason.trim() ||
                    !Array.isArray(entry.used_in_steps)) {
                    report.global_errors.push(`generated_images.json asset '${id}' is missing a valid kind, reason, or used_in_steps ledger`);
                }
                if (entry && entry.kind === 'external-surface' &&
                    (!EXTERNAL_SURFACES.has(entry.surface) || !EXTERNAL_SOURCE_BASES.has(entry.source_basis) ||
                    !Array.isArray(entry.source_files) || entry.source_files.some(source => !isSafeProjectRelativePath(source)) ||
                    (entry.source_basis === 'repository' && entry.source_files.length === 0) ||
                    !Array.isArray(entry.required_text) ||
                    entry.required_text.length === 0 || !entry.text_fidelity ||
                    entry.text_fidelity.enforcement !== 'prompt-constrained' ||
                    entry.text_fidelity.required_text_count !== entry.required_text.length)) {
                    report.global_errors.push(`generated_images.json external surface '${id}' is missing its surface, source, exact-text, or fidelity ledger`);
                }
            }
        } catch (error) {
            report.global_errors.push(`generated_images.json is not valid JSON: ${error.message}`);
        }
    }

    // 6. Default-landing-route check (walkthroughs only — articles skip if absent)
    if (vs.default_landing_route) {
        const landing = vs.default_landing_route;
        if (!landing.primary_view) {
            report.global_errors.push('default_landing_route is missing primary_view');
        } else if (!fs.existsSync(path.join(projectDir, landing.primary_view))) {
            report.global_errors.push(
                `default_landing_route.primary_view does not exist: ${landing.primary_view}`
            );
        }
        const step0 = (vs.steps || []).find(s => s.index === 0);
        if (!step0) {
            report.global_errors.push('view_sources.json has no step with index 0');
        } else {
            if (landing.url_or_route && step0.url_or_route !== landing.url_or_route) {
                report.global_errors.push(
                    `step 0 url_or_route "${step0.url_or_route}" does not match ` +
                    `default_landing_route "${landing.url_or_route}". Step 0 must depict the page ` +
                    `a default user lands on after sign-in. Reorder the steps so the walkthrough ` +
                    `opens on the landing page and the cursor navigates from there toward the topic.`
                );
            }
            if (landing.primary_view && step0.primary_view !== landing.primary_view) {
                report.global_errors.push(
                    `step 0 primary_view "${step0.primary_view}" does not match ` +
                    `default_landing_route.primary_view "${landing.primary_view}".`
                );
            }
        }
        if (report.global_errors.length > 0) report.all_passed = false;
    }

    // Desktop shell-region enforcement: when detect recorded a persistent
    // status bar in app_shell, every framed desktop mockup must render it.
    // Prose contracts alone proved unreliable here — models drop persistent
    // chrome; this is the deterministic backstop (same rationale as the
    // emoji-icon check).
    let desktopShell = null;
    // css_build recipe presence = the render JIT is live for this project; the
    // contract's macro-layout need-gate keys on it (bones forbidden on the JIT
    // path — they can only override working CSS there).
    let cssBuildRecipe = null;
    // Root-element class enforcement (any app type): detect can record the
    // class tokens the document root carries on a standard authenticated page
    // (app_shell.root_classes — resolved from server-side conditionals ONCE at
    // detect time, because they're often computed and un-greppable: WordPress
    // emits <html class="<?php echo $admin_html_class ?>"> from a helper).
    // Fixed-chrome offsets hang on them (html.wp-toolbar { padding-top: … }
    // keeps the fixed admin bar off the content), so a mockup that renders the
    // shell but drops the root class paints the bar OVER the page.
    let rootShell = null;
    // Game-mode backstops (same rationale): (1) every game mockup renders inside
    // exactly one .game-screen — a fixed-size IN-FLOW playfield; content authored
    // as position:fixed layers over an auto-height body measures a 0-height
    // content extent and screenshots near-blank (observed failure mode); (2) a
    // canvas-state mockup must render the persistent HUD app_shell records.
    let gameShell = null;
    // Layout-chrome consumption (any app type): detect records, per layout, the
    // files that layout unconditionally renders AROUND the page content
    // (layouts[].chrome — top bar, nav/menu header, screen-utility affordances,
    // footer). A step that claims a layout must EXPAND that layout's chrome
    // files in partials_expanded — a chrome file never opened is a chrome
    // region the mockup cannot render (the observed thin-chrome failure: models
    // render the branch containing the step's action and prune the layout's
    // other children). Scope: only steps that CLAIM the layout via their
    // `layout` key (models record either the map's layout name or its path) AND
    // actually render the shell (≥2 recorded nav labels — the root_classes
    // gate) — a fullscreen/standalone state that legitimately drops the shell
    // also drops the shell's chrome, and a step reading a layout file among its
    // partials without claiming the layout is not held to that layout's chrome.
    // Enforcement is graduated by what each entry IS, because legacy maps
    // record heterogeneous values: an entry that resolves to a real file is a
    // hard error when unexpanded; a name-like token (component / partial
    // shorthand) degrades to a basename-match warning; a prose note (contains
    // whitespace) is uncheckable and skipped. Maps without layouts[].chrome
    // skip entirely (backwards compatible).
    let layoutChrome = null;
    let shellNavLabels = [];
    // All map layouts (regardless of chrome lists): a layouts[] entry may also
    // record its own root_classes (a fullscreen editor's root state diverges
    // from the app default — enforced as a REPLACEMENT for the app-shell tokens
    // on steps claiming that layout) and a runtime_chrome recipe (the embedded
    // JS-app's chrome inventory, resolved at detect time — sampled by its
    // recorded UI strings). Both data-gated: absent fields skip.
    let mapLayouts = [];
    let schemaV2 = false;
    let schemaV3 = false;
    let schemaV4 = false;
    let schemaV5 = false;
    let appType = null;
    try {
        const pm = JSON.parse(fs.readFileSync(path.join(projectDir, '.rtfm', 'project_map.json'), 'utf8'));
        appType = pm.app_type || null;
        schemaV2 = Number(pm.schema_version) >= 2;
        schemaV3 = Number(pm.schema_version) >= 3;
        schemaV4 = Number(pm.schema_version) >= 4;
        schemaV5 = Number(pm.schema_version) >= 5;
        if (pm.app_type === 'desktop') desktopShell = pm.app_shell || null;
        if (pm.css_build && typeof pm.css_build === 'object') cssBuildRecipe = pm.css_build;
        if (pm.app_type === 'game') {
            gameShell = {
                appShell: pm.app_shell || null,
                canvasFile: (pm.game_metadata || {}).canvas_file || null,
            };
        }
        const rc = pm.app_shell && pm.app_shell.root_classes;
        if (rc) {
            const toTokens = v => (Array.isArray(v) ? v : String(v || '').split(/\s+/)).filter(Boolean);
            const htmlTokens = toTokens(rc.html);
            const navLabels = (pm.app_shell.nav_items || [])
                .map(n => n && n.label).filter(l => typeof l === 'string' && l.length >= 3);
            if (htmlTokens.length && navLabels.length >= 2) rootShell = { htmlTokens, navLabels };
        }
        mapLayouts = (Array.isArray(pm.layouts) ? pm.layouts : []).filter(l =>
            l && typeof l === 'object' && (l.name || l.path));
        const chromeLayouts = mapLayouts.filter(l =>
            Array.isArray(l.chrome) && l.chrome.length > 0);
        // Same filter as rootShell.navLabels above — the per-step loop counts
        // nav-label hits ONCE against this list and every shell gate reads it.
        shellNavLabels = ((pm.app_shell || {}).nav_items || [])
            .map(n => n && n.label).filter(l => typeof l === 'string' && l.length >= 3);
        if (chromeLayouts.length && shellNavLabels.length >= 2) layoutChrome = chromeLayouts;
        // Stale-cache backstop (WARN, the check-8b pattern): detect's CSS health
        // gate (check 3) hard-fails a FRESH detect whose app_shell.root_classes
        // miss a root-scoped fixed-chrome offset class the bundle proves exists
        // (html.X { padding-top: … }) — but existing caches predate that gate and
        // staleness is manual-only, so surface the defect here without failing.
        // Logic mirrors detect-project/scripts/check_css_health.js (source of truth).
        if (brandingCss && pm.app_shell) {
            const trivial = v => {
                const t = v.replace(/!important/gi, '').trim().toLowerCase();
                return ['initial', 'unset', 'inherit', 'revert', 'auto', ''].includes(t)
                    || /^0(\.0+)?(px|rem|em|%|vh|vw)?$/.test(t) || /^[12](\.\d+)?px$/.test(t);
            };
            const offsets = { html: new Set(), body: new Set() };
            for (const m of brandingCss.matchAll(/([^{};]+)\{([^{}]*)\}/g)) {
                const pt = m[2].match(/(?:^|;)\s*padding-top\s*:\s*([^;]+)/i);
                if (!pt || trivial(pt[1])) continue;
                for (const sm of m[1].matchAll(/(?:^|[,\s])(html|body)\.([A-Za-z0-9_-]+)/g)) {
                    offsets[sm[1]].add(sm[2]);
                }
            }
            const rcAll = pm.app_shell.root_classes || {};
            for (const root of ['html', 'body']) {
                const recorded = Array.isArray(rcAll[root]) ? rcAll[root] : [];
                if (offsets[root].size && !recorded.length) {
                    report.global_warnings.push(
                        `branding.css scopes a fixed-chrome offset to ${root}.` +
                        `${[...offsets[root]].sort().join(` / ${root}.`)} (padding-top rule) but the ` +
                        `cached app_shell.root_classes.${root} is empty — shell mockups may render the ` +
                        `fixed bar over the content. The cache predates the detect-side gate for this; ` +
                        `re-run /detect-project to repair it.`
                    );
                }
            }
        }
    } catch (_) { /* no project map — nothing to enforce */ }

    // Article-only contract: walkthrough article steps deliberately have no
    // has_image field, so lintArticleActionCoverage skips them. This also
    // validates the zero-based article/view/file association that downstream
    // importers use; a human-facing third-step file named step_3 is orphaned.
    let actionCoverageMetric = null;
    const articlePath = path.join(outputDir, 'article.json');
    if (fs.existsSync(articlePath)) {
        try {
            const article = JSON.parse(fs.readFileSync(articlePath, 'utf8'));
            if (blockMode && Array.isArray(article.blocks)) {
                article.steps = article.blocks.filter(block => block.type === 'section');
            }
            const coverage = lintArticleActionCoverage(vs, article, outputDir, appType, generatedManifest);
            report.global_errors.push(...coverage.errors);
            report.global_warnings.push(...coverage.warnings);
            actionCoverageMetric = coverage.metrics.action_coverage;
        } catch (error) {
            report.global_errors.push(`article.json is not valid JSON: ${error.message}`);
        }
    }

    // Runtime-app state coverage (data-gated, article+walkthrough): when a
    // claimed layout's runtime_chrome records `states`, the illustrated set
    // must cover the recorded working states — prompt-rule allocation proved
    // unreliable (four benchmark rounds: the model repeatedly skipped a
    // recorded editing state), so the ledger is enforced here and the retry
    // loop performs the reallocation. Root/overview and entry states are not
    // required (they drop first by contract); a state is matched when the
    // significant words of its name appear in some step's depicted_state.
    let rsTotal = 0, rsHits = 0;   // runtime_states_selected metric (both branches)
    if (mapLayouts.length && schemaV2) {
        const placements = new Set(['top', 'left', 'right', 'bottom', 'canvas',
            'overlay-left', 'overlay-right', 'overlay-center', 'overlay-bottom']);
        for (const l of mapLayouts.filter(x => x.runtime_chrome)) {
            const rcw = l.runtime_chrome;
            const regions = Array.isArray(rcw.regions) ? rcw.regions : [];
            const states = Array.isArray(rcw.states) ? rcw.states : [];
            const regionIds = regions.map(r => r && r.id).filter(Boolean);
            const stateIds = states.map(s => s && s.id).filter(Boolean);
            if (!regions.length || !states.length) {
                report.global_errors.push(`schema-v2 layout '${l.name || l.path}' runtime_chrome requires non-empty regions and states`);
                continue;
            }
            if (!['repo', 'knowledge'].includes(rcw.source_kind)
                || !Array.isArray(rcw.source_files)
                || (rcw.source_kind === 'repo' && !rcw.source_files.length)) {
                report.global_errors.push(
                    `schema-v2 layout '${l.name || l.path}' runtime_chrome requires source_kind and repo-backed source_files`);
            }
            if (new Set(regionIds).size !== regionIds.length || regionIds.length !== regions.length) {
                report.global_errors.push(`schema-v2 layout '${l.name || l.path}' has missing or duplicate runtime region ids`);
            }
            if (new Set(stateIds).size !== stateIds.length || stateIds.length !== states.length) {
                report.global_errors.push(`schema-v2 layout '${l.name || l.path}' has missing or duplicate runtime state ids`);
            }
            for (const r of regions) {
                if (!placements.has(r.placement)) report.global_errors.push(
                    `runtime region '${r.id || '?'}' has invalid placement '${r.placement || ''}'`);
                if (typeof r.required !== 'boolean' || !Array.isArray(r.required_strings)
                    || !Array.isArray(r.source_files)) report.global_errors.push(
                    `runtime region '${r.id || '?'}' is missing required/required_strings/source_files schema fields`);
                if (schemaV3 && (typeof r.appearance !== 'string' || !r.appearance.trim())) {
                    report.global_errors.push(`schema-v3 runtime region '${r.id || '?'}' requires non-empty appearance`);
                }
                if (schemaV4) {
                    const items = Array.isArray(r.items) ? r.items : [];
                    const itemIds = items.map(item => item && item.id);
                    if (!items.length || items.some(item => !item || typeof item.id !== 'string'
                        || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.id)
                        || typeof item.description !== 'string' || !item.description.trim())
                        || new Set(itemIds).size !== itemIds.length) report.global_errors.push(
                        `schema-v4 runtime region '${r.id || '?'}' requires ordered structured items`);
                    if (schemaV5 && items.some(item => typeof item.kind !== 'string'
                        || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.kind)
                        || !Array.isArray(item.required_strings)
                        || item.required_strings.some(value => typeof value !== 'string' || !value.trim()))) {
                        report.global_errors.push(`schema-v5 runtime region '${r.id || '?'}' items require kind and required_strings`);
                    }
                    if (schemaV5 && r.placement === 'right' && (r.ui_strings || []).length >= 4
                        && items.length < 4) report.global_errors.push(
                        `schema-v5 right-panel region '${r.id || '?'}' requires atomic navigable-row items`);
                    if (schemaV5 && typeof r.placement === 'string' && r.placement.startsWith('overlay-')) {
                        const kinds = new Set(items.map(item => item.kind));
                        if (!kinds.has('group-heading') || !kinds.has('selection-row') || !kinds.has('actions')) {
                            report.global_errors.push(`schema-v5 grouped overlay region '${r.id || '?'}' requires group, selection, and action items`);
                        }
                    }
                    if (r.placement === 'canvas') {
                        if (!['populated', 'empty', 'loading'].includes(r.content_mode)
                            || !['required', 'optional', 'none'].includes(r.media_expectation)
                            || !Array.isArray(r.representative_assets)
                            || !Number.isInteger(r.max_selected_outlines) || r.max_selected_outlines < 0) {
                            report.global_errors.push(`schema-v4 canvas region '${r.id || '?'}' is missing its content/media contract`);
                        }
                        if (r.media_expectation === 'required' && !(r.representative_assets || []).length) {
                            report.global_errors.push(`schema-v4 canvas region '${r.id || '?'}' requires representative assets`);
                        }
                    }
                }
            }
            for (const st of states) {
                if (!['overview', 'action', 'confirm'].includes(st.kind)
                    || typeof st.screenshot_required !== 'boolean'
                    || !Array.isArray(st.required_regions) || !Array.isArray(st.required_strings)
                    || !Array.isArray(st.source_files)) report.global_errors.push(
                    `runtime state '${st.id || '?'}' is missing the schema-v2 state contract`);
                const unknown = (st.required_regions || []).filter(id => !regionIds.includes(id));
                if (unknown.length) report.global_errors.push(
                    `runtime state '${st.id || '?'}' references unknown region(s): ${unknown.join(', ')}`);
                if (schemaV3) {
                    const visible = Array.isArray(st.visible_regions) ? st.visible_regions : [];
                    const invalidVisible = visible.filter((id, index) => !regionIds.includes(id)
                        || visible.indexOf(id) !== index);
                    const orderedVisible = regions.filter(r => visible.includes(r.id)).map(r => r.id);
                    if (!visible.length || invalidVisible.length || !sameStringArray(visible, orderedVisible)) {
                        report.global_errors.push(
                            `schema-v3 runtime state '${st.id || '?'}' visible_regions must be unique valid region ids in recipe order`);
                    }
                }
                if (schemaV4 && (!Array.isArray(st.topic_tags) || !st.topic_tags.length
                    || st.topic_tags.some(tag => typeof tag !== 'string' || !tag.trim())
                    || !['orientation', 'primary-action', 'secondary-action', 'terminal-action']
                        .includes(st.instructional_priority))) report.global_errors.push(
                    `schema-v4 runtime state '${st.id || '?'}' requires topic_tags and instructional_priority`);
                if (schemaV5) {
                    if (typeof st.canvas_presentation !== 'string' || !st.canvas_presentation.trim()) {
                        report.global_errors.push(`schema-v5 runtime state '${st.id || '?'}' requires canvas_presentation`);
                    }
                    const hasToolbar = Array.isArray(st.visible_regions) && regions.some(region =>
                        st.visible_regions.includes(region.id) && region.placement === 'top');
                    if (hasToolbar && ['action', 'confirm'].includes(st.kind)
                        && (typeof st.context_label !== 'string' || !st.context_label.trim()
                            || !Array.isArray(st.required_strings)
                            || !st.required_strings.includes(st.context_label))) report.global_errors.push(
                        `schema-v5 runtime state '${st.id || '?'}' requires context_label in required_strings`);
                }
                if (st.kind === 'overview' && st.screenshot_required) report.global_errors.push(
                    `runtime overview state '${st.id || '?'}' cannot be screenshot_required`);
            }
            if (schemaV3) {
                for (const r of regions) {
                    const universal = states.length > 0 && states.every(st =>
                        Array.isArray(st.visible_regions) && st.visible_regions.includes(r.id));
                    if (r.required !== universal) report.global_errors.push(
                        `schema-v3 runtime region '${r.id || '?'}' required must equal visibility in every state`);
                }
            }
            if (states.filter(st => st.screenshot_required).length > 3) report.global_errors.push(
                `schema-v2 layout '${l.name || l.path}' has more than three screenshot_required states`);
            const recipeSources = [rcw.source_files, ...regions.map(r => r.source_files),
                ...states.map(s => s.source_files)].flat().filter(v => typeof v === 'string');
            if (rcw.source_kind === 'repo') {
                for (const rel of new Set(recipeSources)) {
                    if (!fs.existsSync(path.join(projectDir, rel))) report.global_errors.push(
                        `schema-v2 runtime recipe source does not exist: ${rel}`);
                }
            }
        }

        const claimed = mapLayouts.filter(l => l.runtime_chrome && (vs.steps || []).some(
            s => s && (s.layout === l.path || s.layout === l.name)));
        for (const l of claimed) {
            const states = l.runtime_chrome.states || [];
            const ids = new Set(states.map(s => s.id));
            const stepIds = (vs.steps || []).filter(s => s && (s.layout === l.path || s.layout === l.name))
                .map(s => s.runtime_state_id).filter(Boolean);
            const required = states.filter(s => s.screenshot_required).map(s => s.id);
            const selection = vs.runtime_state_selection || {};
            const selected = Array.isArray(selection.selected) ? selection.selected : [];
            if (selection.layout !== l.name && selection.layout !== l.path) report.global_errors.push(
                `runtime_state_selection.layout must identify claimed layout '${l.name || l.path}'`);
            if (!sameStringSet(selected, stepIds)) report.global_errors.push(
                `runtime_state_selection.selected must exactly match illustrated runtime_state_id values for layout '${l.name || l.path}'`);
            const missing = required.filter(id => !selected.includes(id));
            rsTotal += required.length;
            rsHits += required.length - missing.length;
            if (missing.length) report.global_errors.push(
                `layout '${l.name || l.path}' requires screenshot state(s) that were not selected: ${missing.join(', ')}`);
            const unknown = selected.filter(id => !ids.has(id));
            if (unknown.length) report.global_errors.push(`runtime_state_selection contains unknown state id(s): ${unknown.join(', ')}`);
            const dropped = Array.isArray(selection.dropped) ? selection.dropped : [];
            const droppedIds = dropped.map(d => d && d.id).filter(Boolean);
            if (new Set(droppedIds).size !== droppedIds.length) report.global_errors.push(
                'runtime_state_selection.dropped contains duplicate state ids');
            for (const d of dropped) {
                if (!d || !ids.has(d.id) || typeof d.reason !== 'string' || !d.reason.trim()) {
                    report.global_errors.push('runtime_state_selection.dropped entries require a known id and non-empty reason');
                }
                if (d && selected.includes(d.id)) report.global_errors.push(`runtime state '${d.id}' is both selected and dropped`);
            }
            const unaccounted = states.map(st => st.id)
                .filter(id => !selected.includes(id) && !droppedIds.includes(id));
            if (unaccounted.length) report.global_errors.push(
                `runtime_state_selection must select or explain every state; unaccounted: ${unaccounted.join(', ')}`);
        }
        if (report.global_errors.length > 0) report.all_passed = false;
    } else if (mapLayouts.length) {
        const claimedLayouts = new Set((vs.steps || []).map(s => s && s.layout).filter(Boolean));
        for (const l of mapLayouts) {
            if (!claimedLayouts.has(l.path) && !claimedLayouts.has(l.name)) continue;
            const states = (l.runtime_chrome && Array.isArray(l.runtime_chrome.states))
                ? l.runtime_chrome.states : [];
            const required = states.filter(st => st && typeof st.name === 'string'
                && !/root|overview|entry|home/i.test(st.name));
            if (!required.length) continue;
            const depictedPerStep = (vs.steps || [])
                .map(s => String((s && s.depicted_state) || '').toLowerCase()).filter(Boolean);
            const missing = required.filter(st => {
                // ALL significant words must appear in ONE step's depicted_state.
                // (Any-word matching let a "styles editing" step satisfy
                // "template open for editing"; joined-corpus matching let a nav
                // enumeration mentioning "Templates" supply the missing word.)
                const words = st.name.toLowerCase().split(/\s+/).filter(w => w.length >= 4);
                return words.length && !depictedPerStep.some(d => words.every(w => d.includes(w)));
            }).map(st => st.name);
            rsTotal += required.length;
            rsHits += required.length - missing.length;
            if (missing.length) {
                report.global_errors.push(
                    `layout '${l.name || l.path}' records runtime working states that no illustrated ` +
                    `step depicts: ${missing.join('; ')}. The recorded states are the coverage ledger — ` +
                    `add or reallocate a step for each (per its states[].shows line), updating ` +
                    `article.json, view_sources.json (depicted_state naming the state), and its mockup.`
                );
            }
        }
        if (report.global_errors.length > 0) report.all_passed = false;
    }

    // Walkthrough runs ship an actions.json next to the mockups; its step count
    // is the recorder's source of truth for which step is last (the last step
    // has no advance trigger). Articles have no actions.json, so the interaction
    // checks (check 7) are skipped entirely for them.
    let walkthrough = null;
    const actionsPath = path.join(outputDir, 'actions.json');
    if (fs.existsSync(actionsPath)) {
        let stepCount = (vs.steps || []).length;
        try {
            const actions = JSON.parse(fs.readFileSync(actionsPath, 'utf8'));
            if (Array.isArray(actions.steps) && actions.steps.length) stepCount = actions.steps.length;
        } catch { /* unreadable actions.json — fall back to vs.steps length */ }
        // Also load narration.json (if present) so check 7 can flag narration that
        // promises an interaction the mockup never performs. Optional — absent/unreadable
        // narration just skips that sub-check.
        const narrationByIndex = {};
        try {
            const narration = JSON.parse(fs.readFileSync(path.join(outputDir, 'narration.json'), 'utf8'));
            for (const s of (narration.steps || [])) {
                if (s && Number.isInteger(s.index) && typeof s.text === 'string') narrationByIndex[s.index] = s.text;
            }
        } catch { /* no/unreadable narration.json — narration sub-check is skipped */ }
        walkthrough = { lastIndex: stepCount - 1, narrationByIndex };
    }

    // Global check 8b (WARN only): custom properties consumed without a fallback
    // in the CSS bundle must be defined SOMEWHERE the render can see — the bundle
    // itself, the JIT output, or a mockup's own <style>/:root block. An undefined
    // var invalidates its whole declaration (background: var(--theme) + color:#fff
    // = invisible white-on-white buttons).
    let undefinedVarsCount = null;
    if (brandingCss) {
        let definitionCorpus = brandingCss + '\n' + mockupCss;
        for (const step of vs.steps || []) {
            definitionCorpus += '\n' + loadFileOrEmpty(path.join(outputDir, `step_${step.index}.html`));
        }
        const definedAnywhere = new Set();
        for (const m of definitionCorpus.matchAll(/(?:^|[{;\s"'])(--[A-Za-z0-9_-]+)\s*:/g)) definedAnywhere.add(m[1]);
        for (const m of definitionCorpus.matchAll(/@property\s+(--[A-Za-z0-9_-]+)/g)) definedAnywhere.add(m[1]);
        const undefinedVars = findUndefinedCssVars(brandingCss + '\n' + mockupCss)
            .filter(([name]) => !definedAnywhere.has(name));
        undefinedVarsCount = undefinedVars.length;
        if (undefinedVars.length) {
            const shown = undefinedVars.slice(0, 5)
                .map(([name, uses]) => `${name} (${uses}x)`).join(', ');
            report.global_warnings.push(
                `branding.css consumes custom properties without fallbacks that are never defined: ` +
                `${shown}${undefinedVars.length > 5 ? ', …' : ''}. Every declaration using them is ` +
                `invalid at render time (e.g. themed button backgrounds silently vanish). The bundle ` +
                `is likely missing its theme/tokens stylesheet — re-run /detect-project to repair the cache.`
            );
        }
    }

    for (const step of vs.steps || []) {
        const externalStep = Boolean(step.external_surface);
        const { errors, warnings, metrics } = lintStep(step, outputDir, projectDir, brandingCss, colourWhitelist,
            walkthrough, selectorSets, generatedManifest);
        // One read + one nav-label count per step; every shell gate below reads
        // these (they used to be recomputed inline at each site — same list, same
        // file, so the hoist is behaviour-identical).
        const stepHtml = loadFileOrEmpty(path.join(outputDir, `step_${step.index}.html`));
        const navHits = stepHtml ? shellNavLabels.filter(l => stepHtml.includes(l)).length : 0;
        if (stepHtml && shellNavLabels.length >= 2) metrics.shell_nav_labels = metricRatio(navHits, shellNavLabels.length);
        if (!externalStep && desktopShell && desktopShell.statusbar) {
            if (stepHtml && stepHtml.includes('desktop-window') && !stepHtml.includes('desktop-statusbar')) {
                errors.push(
                    'app_shell records a persistent status bar but this mockup has no .desktop-statusbar — ' +
                    'render the shell status bar (last child of the app root) with the content the map describes'
                );
            }
        }
        // Desktop macro-layout bones: misassembly is a hard error (a pane
        // outside the fixed desktop-app-rows > desktop-app-columns > panes
        // assembly renders zero-height); bones used at all while the JIT is
        // live (css_build recipe present) draws a need-gate warning — contract
        // variant A mandates the app's own classes there. Gated purely on the
        // classes appearing in markup, so non-desktop mockups skip untouched.
        if (!externalStep) {
            if (stepHtml) {
                const bones = scanPaneBones(stepHtml);
                errors.push(...bones.errors);
                if (bones.used && cssBuildRecipe && !bones.errors.length) {
                    warnings.push(
                        'desktop-app-*/desktop-pane-* macro-layout bones are used, but project_map.css_build ' +
                        'records a working recipe — the JIT compiles the mockup\'s own utility classes, so the ' +
                        'app\'s real layout classes are the mandated macro layout (contract variant A); the ' +
                        'bones\' !important sizing can only override working CSS here.'
                    );
                }
            }
        }
        // Per-layout root_classes override + runtime_chrome sampling. A step
        // claiming a layout that records root_classes is held to THAT layout's
        // tokens instead of the app-shell defaults (fullscreen/zen modes both
        // add their mode token and drop the hidden top bar's offset class), so
        // the app-shell root check below is skipped for it.
        let layoutRootOverride = false;
        // Per-layout metric accumulators — SUM across the step's claimed layouts.
        let lrcTotal = 0, lrcMissing = 0, rrTotal = 0, rrHits = 0, uiTotal = 0, uiHits = 0;
        if (mapLayouts.length && step.layout) {
            const claimed = mapLayouts.filter(l => step.layout === l.path || step.layout === l.name);
            for (const l of claimed) {
                const lrc = l.root_classes;
                if (lrc && typeof lrc === 'object' && stepHtml) {
                    layoutRootOverride = true;
                    const toTokens = v => (Array.isArray(v) ? v : String(v || '').split(/\s+/)).filter(Boolean);
                    const have = {
                        html: new Set(extractHtmlClass(stepHtml).split(/\s+/).filter(Boolean)),
                        body: new Set(((stepHtml.match(/<body[^>]*\bclass\s*=\s*"([^"]*)"/i) || [, ''])[1] || '')
                            .split(/\s+/).filter(Boolean)),
                    };
                    for (const root of ['html', 'body']) {
                        const expectedTokens = toTokens(lrc[root]);
                        const missing = expectedTokens.filter(t => !have[root].has(t));
                        lrcTotal += expectedTokens.length;
                        lrcMissing += missing.length;
                        if (missing.length) {
                            errors.push(
                                `this step claims layout '${l.name || l.path}', which records its own ` +
                                `root_classes — <${root}> is missing: ${missing.join(', ')}. A layout's ` +
                                `recorded root state REPLACES the app-shell defaults (its mode tokens and ` +
                                `chrome offsets hang on them).`
                            );
                        }
                    }
                }
                const rcw = l.runtime_chrome;
                if (schemaV2 && rcw && stepHtml) {
                    const states = Array.isArray(rcw.states) ? rcw.states : [];
                    const regions = Array.isArray(rcw.regions) ? rcw.regions : [];
                    const state = states.find(s => s.id === step.runtime_state_id);
                    if (!step.runtime_state_id || !state) {
                        errors.push(`schema-v2 runtime step requires a valid runtime_state_id for layout '${l.name || l.path}'`);
                    } else {
                        const bodyStates = dataAttrTags(stepHtml, 'data-rtfm-state');
                        if (bodyStates.length !== 1 || bodyStates[0].value !== state.id
                            || !/^<body\b/i.test(bodyStates[0].tag)) {
                            errors.push(`step_${step.index}.html must put data-rtfm-state="${state.id}" exactly once on <body>`);
                        }
                        const visibleIds = schemaV3
                            ? new Set(state.visible_regions || [])
                            : new Set(regions.filter(r => r.required).map(r => r.id));
                        if (!schemaV3) {
                            for (const id of state.required_regions || []) visibleIds.add(id);
                        }
                        const requiredRegions = regions.filter(r => visibleIds.has(r.id));
                        rrTotal += requiredRegions.length;
                        for (const r of requiredRegions) {
                            const tags = dataAttrTags(stepHtml, 'data-rtfm-region', r.id);
                            if (tags.length !== 1) {
                                errors.push(`runtime region '${r.id}' must appear exactly once in step_${step.index}.html (found ${tags.length})`);
                                continue;
                            }
                            rrHits++;
                            const placements = dataAttrTags(tags[0].tag, 'data-rtfm-placement');
                            if (placements.length !== 1 || placements[0].value !== r.placement) errors.push(
                                `runtime region '${r.id}' must declare data-rtfm-placement="${r.placement}"`);
                            for (const str of r.required_strings || []) {
                                if (!stepHtml.includes(str)) errors.push(`runtime region '${r.id}' requires visible string "${str}"`);
                            }
                            if (schemaV4) {
                                let previous = -1;
                                for (const item of r.items || []) {
                                    const marker = `${r.id}:${item.id}`;
                                    const itemTags = dataAttrTags(stepHtml, 'data-rtfm-item', marker);
                                    if (itemTags.length !== 1) {
                                        errors.push(`runtime item '${marker}' must appear exactly once in step_${step.index}.html (found ${itemTags.length})`);
                                        continue;
                                    }
                                    const position = stepHtml.indexOf(itemTags[0].tag, previous + 1);
                                    if (position <= previous) errors.push(
                                        `runtime item '${marker}' must appear in the recipe's recorded order`);
                                    previous = position;
                                    if (schemaV5) {
                                        for (const str of item.required_strings || []) {
                                            if (!stepHtml.includes(str)) errors.push(
                                                `runtime item '${marker}' requires visible string "${str}"`);
                                        }
                                    }
                                }
                                if (schemaV5 && r.placement.startsWith('overlay-')
                                    && /\b(?:no changes?|unchanged)\b/i.test(stepHtml)) errors.push(
                                    `runtime confirmation must list concrete changed entities, not unchanged/no-change rows`);
                                if (r.placement === 'canvas') {
                                    for (const asset of r.representative_assets || []) {
                                        const assetTags = dataAttrTags(stepHtml, 'data-rtfm-asset', asset);
                                        if (assetTags.length !== 1) errors.push(
                                            `runtime canvas asset '${asset}' must appear exactly once in step_${step.index}.html (found ${assetTags.length})`);
                                    }
                                    const outlineCount = (stepHtml.match(/\boutline\s*:\s*[^;"']+/gi) || []).length;
                                    if (outlineCount > r.max_selected_outlines) errors.push(
                                        `runtime canvas permits at most ${r.max_selected_outlines} selected outline(s); found ${outlineCount}`);
                                }
                            }
                        }
                        if (schemaV3) {
                            const recipeIds = new Set(regions.map(r => r.id));
                            const renderedIds = dataAttrTags(stepHtml, 'data-rtfm-region')
                                .map(t => t.value).filter(id => recipeIds.has(id));
                            for (const id of renderedIds) {
                                if (!visibleIds.has(id)) errors.push(
                                    `runtime region '${id}' is not visible in state '${state.id}' and must not render in step_${step.index}.html`);
                            }
                        }
                        for (const str of state.required_strings || []) {
                            if (!stepHtml.includes(str)) errors.push(`runtime state '${state.id}' requires visible string "${str}"`);
                        }
                        const expectedSources = [...new Set([
                            ...(rcw.source_files || []),
                            ...requiredRegions.flatMap(r => r.source_files || []),
                            ...(state.source_files || []),
                        ])].sort();
                        const declared = Array.isArray(step.runtime_source_files) ? [...new Set(step.runtime_source_files)].sort() : [];
                        if (!sameStringSet(expectedSources, declared)) errors.push(
                            `runtime_source_files must exactly match the selected recipe sources; expected [${expectedSources.join(', ')}], got [${declared.join(', ')}]`);
                        const allStepSources = new Set([step.primary_view, step.layout,
                            ...(step.partials_expanded || [])].filter(Boolean));
                        const omitted = expectedSources.filter(s => !allStepSources.has(s));
                        if (omitted.length) errors.push(`runtime recipe source(s) missing from primary/layout/partials: ${omitted.join(', ')}`);
                    }
                }
                const uiStrings = (rcw && Array.isArray(rcw.regions) ? rcw.regions : [])
                    .flatMap(r => (r && Array.isArray(r.ui_strings)) ? r.ui_strings : [])
                    .filter(s => typeof s === 'string' && s.length >= 3);
                // Measured on every schema (metric); enforced below only on legacy maps.
                const stepUiHits = (uiStrings.length && stepHtml)
                    ? uiStrings.filter(s => stepHtml.includes(s)).length : null;
                if (stepUiHits !== null) {
                    uiTotal += uiStrings.length;
                    uiHits += stepUiHits;
                }
                if (!schemaV2 && stepUiHits !== null) {
                    // Majority of the recipe's recorded strings (floor 3): a thin
                    // stand-in typically carries the obvious few (Publish, Add
                    // title) while dropping whole regions.
                    const hits = stepUiHits;
                    const need = Math.min(uiStrings.length, Math.max(3, Math.ceil(uiStrings.length / 2)));
                    if (hits < need) {
                        warnings.push(
                            `layout '${l.name || l.path}' records runtime_chrome for its embedded app but ` +
                            `only ${hits}/${uiStrings.length} of its recorded UI strings appear in this ` +
                            `mockup — render the recipe's regions in their recorded order with their real labels.`
                        );
                    }
                }
                // Mode contradiction: the layout records NO visible app chrome
                // (chrome: []) plus a runtime app that draws its own (runtime_chrome),
                // yet the mockup renders the app shell — the wrong-mode failure
                // (admin sidebar wrapped around a fullscreen editor). Majority
                // nav-label gate as elsewhere.
                if (rcw && Array.isArray(l.chrome) && l.chrome.length === 0
                    && shellNavLabels.length >= 2 && stepHtml) {
                    if (navHits >= Math.max(3, Math.ceil(shellNavLabels.length / 2))) {
                        errors.push(
                            `this step claims layout '${l.name || l.path}', which records no visible app ` +
                            `chrome (chrome: []) and a runtime_chrome recipe — but the mockup renders the ` +
                            `app shell (${navHits}/${shellNavLabels.length} nav labels present). In this ` +
                            `layout's default mode the runtime app draws ALL chrome: remove the sidebar/top ` +
                            `bar and render the recipe's regions instead.`
                        );
                    }
                }
            }
        }
        if (lrcTotal) metrics.layout_root_classes = metricRatio(lrcTotal - lrcMissing, lrcTotal);
        if (rrTotal) metrics.runtime_regions_rendered = metricRatio(rrHits, rrTotal);
        if (uiTotal) metrics.runtime_ui_strings = metricRatio(uiHits, uiTotal);
        if (!externalStep && rootShell && !layoutRootOverride) {
            // Enforce only on mockups that actually render the app shell (≥2 of
            // the recorded nav labels present) — standalone pages (login, public)
            // legitimately carry no shell and no root state class.
            const shellShown = navHits >= 2;
            if (stepHtml && shellShown) {
                const have = new Set(extractHtmlClass(stepHtml).split(/\s+/).filter(Boolean));
                const missing = rootShell.htmlTokens.filter(t => !have.has(t));
                metrics.root_classes_html = metricRatio(rootShell.htmlTokens.length - missing.length, rootShell.htmlTokens.length);
                if (missing.length) {
                    errors.push(
                        `<html> element is missing class token(s) recorded in app_shell.root_classes: ` +
                        `${missing.join(', ')}. These are load-bearing — fixed-chrome offsets ` +
                        `(html.<class> { padding-top: … }) and theme scoping hang on them; without them ` +
                        `fixed top bars overlap the content. Add them to the mockup's <html> tag.`
                    );
                }
            }
        }
        if (!externalStep && gameShell) {
            if (stepHtml) {
                const screenCount = (stepHtml.match(/class="[^"]*\bgame-screen\b[^"]*"/g) || []).length;
                if (screenCount !== 1) {
                    errors.push(
                        `game mockups must render inside exactly one .game-screen playfield (found ${screenCount}) — ` +
                        'content outside a sized in-flow screen collapses to a blank crop'
                    );
                }
                // HUD backstop, canvas-state steps only: a step is canvas-drawn exactly
                // when its primary_view is the draw-code file. (Do NOT infer from a
                // .game-scene SVG in the markup — UI screens legitimately sit over a
                // scene backdrop and show no HUD.)
                const isCanvasStep = gameShell.canvasFile && step.primary_view === gameShell.canvasFile;
                const shell = gameShell.appShell;
                const hasHudSpec = shell && (shell.hud_selector
                    || (Array.isArray(shell.hud_fields) && shell.hud_fields.length > 0));
                if (isCanvasStep && hasHudSpec) {
                    const hudSel = String(shell.hud_selector || '').replace(/^[#.]/, '');
                    const hasHud = stepHtml.includes('game-hud') || (hudSel && stepHtml.includes(hudSel));
                    if (!hasHud) {
                        errors.push(
                            'app_shell records a persistent in-game HUD but this canvas-state mockup renders ' +
                            "neither the app's real HUD markup nor .game-hud — a gameplay screenshot without " +
                            'its HUD fails realism'
                        );
                    }
                }
            }
        }
        if (layoutChrome && step.layout) {
            // Majority of recorded nav labels (floor 3), not just ≥2: shell labels
            // are common words ("Pages", "Settings") that appear incidentally in
            // non-shell content — a rendered sidebar carries most of its items.
            const shellShown = navHits >= Math.max(3, Math.ceil(shellNavLabels.length / 2));
            const partials = (step.partials_expanded || []).filter(p => typeof p === 'string');
            // A step "claims" a layout when its layout key names it — by path OR
            // by the map's layout name (models record either).
            const claimed = !shellShown ? [] : layoutChrome.filter(l =>
                step.layout === l.path || step.layout === l.name);
            const partialsLower = partials.map(p => p.toLowerCase());
            const basenames = partials.map(p => path.basename(p).replace(/^_/, '').toLowerCase());
            let cfTotal = 0, cfHits = 0;   // chrome_files_expanded: checkable entries (prose excluded)
            for (const l of claimed) {
                const missingFiles = [];
                const missingNames = [];
                let checkable = 0;
                for (const entry of l.chrome) {
                    if (typeof entry !== 'string' || !entry.trim()) continue;
                    if (partials.includes(entry)) { checkable++; continue; }
                    if (fs.existsSync(path.join(projectDir, entry))) {
                        checkable++;
                        missingFiles.push(entry);           // real file, never expanded — hard
                        continue;
                    }
                    if (/\s/.test(entry.trim())) continue;  // prose note — uncheckable
                    checkable++;
                    const token = entry.split('/').pop().replace(/^_/, '').toLowerCase();
                    const hit = token && (basenames.some(b => b.includes(token))
                        || partialsLower.some(p => p.includes(token)));
                    if (!hit) missingNames.push(entry);     // legacy name-like entry — soft
                }
                cfTotal += checkable;
                cfHits += checkable - missingFiles.length - missingNames.length;
                if (missingFiles.length) {
                    errors.push(
                        `this step claims layout '${l.name || l.path}' but never expanded its recorded ` +
                        `chrome file(s): ${missingFiles.join(', ')}. The layout renders these around the ` +
                        `page content unconditionally — open each one, render the region it emits, and ` +
                        `list it in partials_expanded. A chrome file you didn't open is a chrome region ` +
                        `the mockup cannot render.`
                    );
                }
                if (missingNames.length) {
                    warnings.push(
                        `layout '${l.name || l.path}' records chrome ${missingNames.join(', ')} with no ` +
                        `matching entry in partials_expanded — verify the mockup renders those shell ` +
                        `regions (top bar / nav / footer content), not just the branch the step acts on.`
                    );
                }
            }
            if (cfTotal) metrics.chrome_files_expanded = metricRatio(cfHits, cfTotal);
        }
        report.steps.push({
            index: step.index,
            primary_view: step.primary_view || null,
            errors, warnings, metrics,
        });
        if (errors.length > 0) report.all_passed = false;
    }

    // Typed-data continuity (walkthroughs only). A value the walkthrough types into a
    // field should resurface in a LATER step — creating/editing an item and then landing
    // on a list/calendar/detail that shows none of what was entered is the "empty result"
    // failure. WARN only, and only when NONE of the typed values reappear anywhere later
    // (passwords / search terms / sent-and-cleared messages legitimately don't resurface,
    // so a partial match is fine). Presence-of-string check — no fragile emptiness heuristic.
    if (walkthrough) {
        const htmlByIndex = {};
        const typed = [];   // { index, value }
        for (const step of vs.steps || []) {
            const h = loadFileOrEmpty(path.join(outputDir, `step_${step.index}.html`));
            htmlByIndex[step.index] = h;
            for (const m of h.matchAll(/data-walkthrough-type-text\s*=\s*["']([^"']+)["']/gi)) {
                const v = m[1].trim();
                if (v.length >= 3) typed.push({ index: step.index, value: v });
            }
        }
        const indices = Object.keys(htmlByIndex).map(Number);
        // Only values typed before the last step can be expected to reappear downstream.
        const trackable = typed.filter(t => t.index < walkthrough.lastIndex);
        const orphaned = trackable.filter(t =>
            !indices.some(i => i > t.index && htmlByIndex[i] && htmlByIndex[i].includes(t.value)));
        if (trackable.length > 0 && orphaned.length === trackable.length) {
            report.global_warnings.push(
                `none of the values typed in this walkthrough (${[...new Set(trackable.map(t => `"${t.value}"`))].join(', ')}) ` +
                `appear in any later step. If the walkthrough creates or edits an item, the outcome step must ` +
                `display it — labelled with what was entered — not an empty list/calendar/"no results" state. ` +
                `(Ignore for passwords, search terms, or messages that are sent and cleared.)`
            );
        }
    }

    if (report.global_errors.length > 0) report.all_passed = false;
    // Report-level metrics — assembled BEFORE the block-mode rename below, which
    // deletes report.steps.
    report.metrics = {
        action_coverage: actionCoverageMetric,
        runtime_states_selected: rsTotal ? metricRatio(rsHits, rsTotal) : null,
        undefined_css_vars: undefinedVarsCount === null ? null : { count: undefinedVarsCount },
        errors_total: report.global_errors.length + report.steps.reduce((n, s) => n + s.errors.length, 0),
        warnings_total: report.global_warnings.length + report.steps.reduce((n, s) => n + s.warnings.length, 0),
    };
    if (blockMode) {
        report.blocks = report.steps.map(step => ({
            ...step,
            block_id: vs.steps.find(entry => entry.index === step.index)?.block_id,
        }));
        delete report.steps;
    }
    fs.writeFileSync(path.join(outputDir, 'lint_report.json'), JSON.stringify(report, null, 2));

    for (const e of report.global_errors) {
        console.log(`[FAIL] (global) ERROR: ${e}`);
    }
    for (const w of report.global_warnings) {
        console.log(`[WARN] (global) WARN:  ${w}`);
    }
    for (const s of report.blocks || report.steps) {
        const marker = s.errors.length > 0 ? '[FAIL]' : (s.warnings.length > 0 ? '[WARN]' : '[ OK ]');
        console.log(`${marker} ${s.block_id ? `block_${s.block_id}` : `step_${s.index}`} (${s.primary_view || '<no primary_view>'})`);
        for (const e of s.errors) console.log(`       ERROR: ${e}`);
        for (const w of s.warnings) console.log(`       WARN:  ${w}`);
    }

    if (!report.all_passed) {
        console.log('');
        console.log('Mockup-fidelity lint failed. Regenerate the offending step(s) using the ERROR text above.');
        console.log(`Structured findings: ${path.join(outputDir, 'lint_report.json')}`);
        process.exit(1);
    }
    console.log('\nAll steps passed mockup-fidelity lint.');
    process.exit(0);
}

main();
