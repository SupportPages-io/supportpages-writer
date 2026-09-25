#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { verifyLabelEvidence } = require('./label_evidence.js');
const { ARTICLE_TYPES, PRESENTATIONS, blocks, articleType } = require('./article_blocks');

function typeOf(value) {
    if (Array.isArray(value)) return 'array';
    if (value === null) return 'null';
    return typeof value;
}

// ---- Markdown code scanner -------------------------------------------------
// Line-based and CommonMark-shaped: a line whose first non-blank run is three
// or more backticks or tildes opens a fence with an optional info string (a
// backtick fence takes no backtick in its info string, so "```x```" stays
// inline); the same marker character, at least as long, alone on a line closes
// it. `prose` is the text with fence bodies and inline spans removed, so the
// sentence cap and bold extraction never see code; `inline` holds the span
// texts and `fences` the blocks, each with its language tag and closed flag.
function scanCode(text) {
    const prose = [], inline = [], fences = [];
    let open = null;
    for (const line of String(text || '').split('\n')) {
        if (open) {
            const close = line.match(/^[ \t]*(`{3,}|~{3,})[ \t]*$/);
            if (close && close[1][0] === open.marker[0] && close[1].length >= open.marker.length) { open.closed = true; open = null; }
            else open.body.push(line);
            continue;
        }
        const start = line.match(/^[ \t]*(`{3,}|~{3,})(.*)$/);
        if (start && !(start[1][0] === '`' && start[2].includes('`'))) {
            open = { marker: start[1], lang: start[2].trim().split(/\s+/)[0] || '', body: [], closed: false };
            fences.push(open);
            continue;
        }
        prose.push(line.replace(/(`+)([^`]+?)\1/g, (_, __, span) => { inline.push(span.trim()); return ' '; }));
    }
    return { prose: prose.join('\n'), inline, fences: fences.map(f => ({ lang: f.lang, body: f.body.join('\n'), closed: f.closed })) };
}

function checkSchema(article) {
    const errors = [];
    const keys = Object.keys(article).sort();
    const allowed = ['article_type', 'blocks', 'schema_version', 'title'];
    if (article.schema_version !== 2) errors.push('"schema_version" must be 2');
    if (typeof article.title !== 'string' || !article.title.trim()) errors.push('"title" must be a non-empty string');
    if (!ARTICLE_TYPES.includes(article.article_type)) errors.push(`"article_type" must be one of ${ARTICLE_TYPES.join('|')}`);
    if (!Array.isArray(article.blocks) || !article.blocks.length) errors.push('"blocks" must be a non-empty array');
    for (const key of keys) if (!allowed.includes(key)) errors.push(`unknown top-level key "${key}" — schema v2 uses blocks only`);

    const ids = new Set();
    for (const [index, block] of (article.blocks || []).entries()) {
        const at = `blocks[${index}]`;
        if (!block || typeof block !== 'object' || Array.isArray(block)) { errors.push(`${at} must be an object`); continue; }
        if (typeof block.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(block.id)) errors.push(`${at}.id must be URL-safe kebab-case`);
        else if (ids.has(block.id)) errors.push(`${at}.id "${block.id}" is duplicated`);
        else ids.add(block.id);
        if (!Object.hasOwn(PRESENTATIONS, block.type)) { errors.push(`${at}.type must be prose|section|list`); continue; }
        if (!PRESENTATIONS[block.type].includes(block.presentation)) errors.push(`${at}.presentation is invalid for ${block.type}`);
        const allowedKeys = {
            prose: ['id', 'type', 'presentation', 'title', 'content'],
            section: ['id', 'type', 'presentation', 'title', 'content', 'has_image'],
            list: ['id', 'type', 'presentation', 'title', 'items'],
        }[block.type];
        for (const key of Object.keys(block)) if (!allowedKeys.includes(key)) errors.push(`${at} has unknown key "${key}"`);
        if (block.type === 'prose' && typeof block.content !== 'string') errors.push(`${at}.content must be a string`);
        if (block.type === 'section') {
            if (typeof block.title !== 'string' || !block.title.trim()) errors.push(`${at}.title must be non-empty`);
            if (typeof block.content !== 'string') errors.push(`${at}.content must be a string`);
            if (typeof block.has_image !== 'boolean') errors.push(`${at}.has_image must be a boolean`);
        }
        if (block.type === 'list') {
            if (typeof block.title !== 'string' || !block.title.trim()) errors.push(`${at}.title must be non-empty`);
            if (!Array.isArray(block.items) || block.items.some(item => typeof item !== 'string')) errors.push(`${at}.items must be an array of strings`);
        }
        // Fence placement is part of the rendering contract: the app renders the
        // lead and list items inline-only, so a fence there reaches readers as raw
        // backticks, and an unclosed fence swallows the rest of the block.
        if (block.type === 'prose' && block.presentation === 'lead' && typeof block.content === 'string') {
            if (scanCode(block.content).fences.length) errors.push(`${at} (lead prose) must not contain a fenced code block — the lead renders inline-only; move the snippet to a section`);
        } else if ((block.type === 'prose' || block.type === 'section') && typeof block.content === 'string') {
            if (scanCode(block.content).fences.some(fence => !fence.closed)) errors.push(`${at} has an unclosed fenced code block`);
        }
        if (block.type === 'list' && Array.isArray(block.items)) {
            block.items.forEach((item, position) => {
                if (typeof item === 'string' && scanCode(item).fences.length) errors.push(`${at}.items[${position}] must not contain a fenced code block — list items render inline-only`);
            });
        }
    }
    return errors;
}

function loadFileOrEmpty(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } }
function makeCorpus(text) {
    const raw = text.toLowerCase();
    return { raw, flat: text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').toLowerCase(), compact: raw.replace(/[-_]/g, '') };
}
function corpusHas(corpus, term) { const value = term.toLowerCase(); return corpus.raw.includes(value) || corpus.flat.includes(value.replace(/\s+/g, ' ')); }
// Flags and identifiers rarely appear in the sources spelled the way the user
// types them (a derive-based CLI declares `send_message` and exposes
// `--send-message`), so code tokens also match with dashes/underscores removed.
function corpusHasCode(corpus, token) { return corpusHas(corpus, token) || corpus.compact.includes(token.toLowerCase().replace(/^-+/, '').replace(/[-_]/g, '')); }
function extractBoldTerms(text) {
    const terms = []; const re = /\*\*([^*\n]+?)\*\*/g; let match;
    while ((match = re.exec(text || '')) !== null) {
        const term = match[1].trim().replace(/^['"`“”‘’]+|['"`“”‘’]+$/g, '').replace(/[.,:;!?]+$/g, '');
        if (term && term.length <= 80 && /[\p{L}\p{N}]/u.test(term)) terms.push(term);
    }
    return terms;
}
function segments(term) { const parts = term.split(/\s*[›»→]\s*|\s+>\s+/).filter(Boolean); return parts.length > 1 ? parts : [term]; }

const FLAG_RE = /(?<![\w-])--?[a-z][\w-]*/gi;
// The code tokens worth checking against the sources: single-token spans that
// look like a flag, path or identifier (plain words such as `clear` are too
// generic to ground), plus every flag inside multi-token spans and fence bodies.
function codeTokens(scan) {
    const tokens = new Set();
    for (const span of scan.inline) {
        if (!span || /^<[^>]+>$/.test(span) || /^["'].*["']$/.test(span) || /…|\.\.\./.test(span)) continue;
        if (!/\s/.test(span)) { if (/[a-z]/i.test(span) && /^-|[/._-]|^~/.test(span)) tokens.add(span); continue; }
        for (const flag of span.match(FLAG_RE) || []) tokens.add(flag);
    }
    for (const fence of scan.fences) for (const flag of fence.body.match(FLAG_RE) || []) tokens.add(flag);
    return [...tokens];
}
// A bold span that is really a command, flag or path — the observed failure on
// CLI projects before inline code existed in the prose rules.
function looksLikeCode(term, binary) {
    if (/^-{1,2}[a-z]/i.test(term)) return 'flag';
    if (/^(~|\.{1,2})?\/[\w.-]/.test(term) || /^[\w-]+(\/[\w.-]+)+\.\w{1,5}$/.test(term)) return 'path';
    if (/\s--?[a-z][\w-]*/i.test(term)) return 'command';
    if (binary) {
        const lower = term.toLowerCase(), name = binary.toLowerCase();
        if (lower === name || lower.startsWith(name + ' ')) return 'command';
    }
    return null;
}

function buildCorpora(viewSources, projectDir) {
    const perId = new Map(); let union = '';
    for (const entry of (viewSources && (viewSources.blocks || viewSources.steps)) || []) {
        const files = [entry.primary_view, entry.layout, ...(entry.partials_expanded || [])].filter(Boolean);
        let text = files.map(file => loadFileOrEmpty(path.join(projectDir, file))).join('\n');
        text += '\n' + (entry.verbatim_evidence || []).filter(item => verifyLabelEvidence(item, entry.primary_view, projectDir).ok).map(item => typeof item === 'object' ? item.string : item).join('\n');
        const id = entry.block_id || (typeof entry.index === 'number' ? `step-${entry.index + 1}` : null);
        if (id) perId.set(id, makeCorpus(text));
        union += text;
    }
    return { perId, union: makeCorpus(union) };
}

// A terminal mockup that shows only the typed prompt line duplicates the
// article's fenced block without being copyable; the slot belongs to output the
// reader must read, or to a TUI state.
function redundantCommandMockup(block, outputDir) {
    const html = loadFileOrEmpty(path.join(outputDir, `block_${block.id}.html`));
    if (!html || !/\bterminal-cmd\b/.test(html) || /\btui-screen\b/.test(html)) return false;
    const outputs = [...html.matchAll(/class="[^"]*\bterminal-output\b[^"]*"[^>]*>([\s\S]*?)<\/span>/g)]
        .map(match => match[1].replace(/<[^>]*>/g, '').trim()).filter(Boolean);
    return outputs.length === 0;
}

function checkFidelity(article, corpora, options) {
    const { warnMode, outputDir, appType, binary } = options;
    const hasSources = corpora.union.raw.trim().length > 0;
    const reports = [], metrics = { inline_code_spans: 0, fenced_blocks: 0, untagged_fences: 0 };
    for (const block of blocks(article)) {
        const errors = [], warnings = [];
        const content = typeof block.content === 'string' ? block.content : '';
        const scan = scanCode(content);
        metrics.inline_code_spans += scan.inline.length;
        metrics.fenced_blocks += scan.fences.length;
        if (block.type === 'prose' || block.type === 'section') {
            for (const fence of scan.fences) if (!fence.lang) { metrics.untagged_fences += 1; warnings.push(`block "${block.id}" has a fenced code block without a language tag (bash, json, toml, text)`); }
        }
        if (block.type !== 'section') { reports.push({ block_id: block.id, errors, warnings }); continue; }
        if (/^\s*(`{3,}|~{3,})/.test(content)) warnings.push(`section "${block.id}" starts with a code block — lead with the instruction sentence`);
        if (/\*\*\s*`[^`\n]+`\s*\*\*/.test(content)) warnings.push(`section "${block.id}" bolds inline code — drop the bold, inline code stands on its own`);
        const own = corpora.perId.get(block.id);
        for (const term of extractBoldTerms(scan.prose)) {
            const kind = looksLikeCode(term, binary);
            if (kind) { warnings.push(`bold "${term}" looks like a ${kind} — bold is for on-screen labels; use inline code`); continue; }
            const parts = segments(term);
            if (own && parts.every(part => corpusHas(own, part))) continue;
            if (parts.every(part => corpusHas(corpora.union, part))) { warnings.push(`bold UI name "${term}" is not in this block's own sources`); continue; }
            const message = `bold UI name "${term}" appears in none of the resolved source files`;
            if (block.has_image && own && !warnMode) errors.push(message); else warnings.push(message);
        }
        if (hasSources) {
            for (const token of codeTokens(scan)) {
                if (own && corpusHasCode(own, token)) continue;
                if (corpusHasCode(corpora.union, token)) { warnings.push(`inline code "${token}" is not in this block's own sources`); continue; }
                warnings.push(`inline code "${token}" appears in none of the resolved source files — invented flag or path?`);
            }
        }
        if (appType === 'terminal' && block.has_image && outputDir && redundantCommandMockup(block, outputDir)) {
            warnings.push(`section "${block.id}" spends a screenshot on a typed command with no output — the fenced block already carries it; set has_image:false or show the output the reader must read`);
        }
        reports.push({ block_id: block.id, errors, warnings });
    }
    return { reports, metrics };
}

function sentenceCount(text) { const prose = scanCode(text).prose.replace(/\*\*/g, ''); const found = prose.match(/[.!?]+(?=\s|$)/g); return found ? found.length : (prose.trim() ? 1 : 0); }
function styleWarnings(article) {
    const warnings = [], type = articleType(article);
    if (type === 'how-to' && !/^how\s+to\b/i.test(article.title || '')) warnings.push('how-to title should start with "How to"');
    if (type === 'faq' && !(article.title || '').trim().endsWith('?')) warnings.push('faq title should end with "?"');
    for (const block of blocks(article)) {
        const cap = type === 'concept' ? 4 : 3;
        if (block.type === 'section' && sentenceCount(block.content) > cap) warnings.push(`block "${block.id}" exceeds the ${cap}-sentence guidance`);
        if (block.type === 'prose' && block.presentation === 'lead' && sentenceCount(block.content) > 2) warnings.push('lead prose should be 1-2 sentences');
    }
    return warnings;
}

function main() {
    const outputDir = process.argv[2], projectDir = process.argv[3] || '.';
    if (!outputDir) process.exit(2);
    let article;
    try { article = JSON.parse(fs.readFileSync(path.join(outputDir, 'article.json'), 'utf8')); }
    catch (error) { console.error(`cannot read article.json: ${error.message}`); process.exit(2); }
    let viewSources = null;
    try { viewSources = JSON.parse(fs.readFileSync(path.join(outputDir, 'view_sources.json'), 'utf8')); } catch {}
    let projectMap = {};
    try { projectMap = JSON.parse(fs.readFileSync(path.join(projectDir, '.rtfm', 'project_map.json'), 'utf8')) || {}; } catch {}
    const appType = projectMap.app_type || (viewSources && viewSources.framework === 'cli' ? 'terminal' : null);
    const binary = projectMap.cli_metadata && typeof projectMap.cli_metadata.binary === 'string' ? projectMap.cli_metadata.binary : null;
    const warnMode = (process.env.RTFM_LINT_MODE || '').toLowerCase() === 'warn';
    const fidelity = checkFidelity(article, buildCorpora(viewSources, projectDir), { warnMode, outputDir, appType, binary });
    const report = {
        all_passed: true,
        mode: warnMode ? 'warn' : 'fail',
        global_errors: checkSchema(article),
        global_warnings: styleWarnings(article),
        blocks: fidelity.reports,
        metrics: fidelity.metrics,
    };
    report.all_passed = !report.global_errors.length && !report.blocks.some(block => block.errors.length);
    fs.writeFileSync(path.join(outputDir, 'article_lint_report.json'), JSON.stringify(report, null, 2));
    for (const error of report.global_errors) console.log(`[FAIL] (schema) ERROR: ${error}`);
    for (const warning of report.global_warnings) console.log(`[WARN] (article) WARN: ${warning}`);
    for (const block of report.blocks) {
        for (const error of block.errors) console.log(`[FAIL] block ${block.block_id}: ${error}`);
        for (const warning of block.warnings) console.log(`[WARN] block ${block.block_id}: ${warning}`);
    }
    if (!report.all_passed) process.exit(1);
    console.log('article.json passed the copy lint.');
}
main();
