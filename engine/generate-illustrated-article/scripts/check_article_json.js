#!/usr/bin/env node
'use strict';

/*
 * check_article_json.js — validate the shape of a schema_version 2 article.json
 * before illustration (Phase 2 flips has_image later, so this checks shape only).
 *
 * Usage: node check_article_json.js <article.json>
 * Exits 0 when valid, 1 with one problem per line.
 */

const fs = require('fs');

const ARTICLE_TYPES = ['how-to', 'troubleshooting', 'concept', 'faq'];
const PRESENTATIONS = {
    prose: ['lead', 'body', 'summary'],
    section: ['numbered', 'plain'],
    list: ['bullets', 'checklist', 'tips'],
};
const BLOCK_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const CODE_FENCE = /```|~~~/;

const isString = value => typeof value === 'string';

/** String form of a value, as a JSON round-trip would render it inside a list. */
function asText(value) {
    return isString(value) ? value : JSON.stringify(value);
}

function check(article) {
    const problems = [];
    if (article === null || typeof article !== 'object' || Array.isArray(article)) return ['article.json must be a JSON object'];
    if (article.schema_version !== 2) problems.push('schema_version must be 2');
    if (!isString(article.title) || !article.title.length) problems.push('title must be a non-empty string');
    if (!ARTICLE_TYPES.includes(article.article_type)) problems.push(`article_type must be one of ${ARTICLE_TYPES.join(', ')}`);

    const blocks = article.blocks;
    if (!Array.isArray(blocks) || !blocks.length) {
        problems.push('blocks must be a non-empty array');
        return problems;
    }

    const ids = blocks.map(block => (block && typeof block === 'object' ? block.id : undefined));
    const seen = new Set();
    for (const id of ids) {
        const key = JSON.stringify(id ?? null);
        if (seen.has(key)) problems.push(`duplicate block id ${key}`);
        seen.add(key);
    }

    blocks.forEach((block, i) => {
        const at = `blocks[${i}]${block && isString(block.id) ? ` (${block.id})` : ''}`;
        if (!block || typeof block !== 'object' || Array.isArray(block)) {
            problems.push(`${at} must be an object`);
            return;
        }
        if (!isString(block.id) || !BLOCK_ID.test(block.id)) problems.push(`${at}.id must be lowercase words joined by hyphens`);

        const allowed = PRESENTATIONS[block.type];
        if (!allowed) {
            problems.push(`${at}.type must be prose, section or list`);
            return;
        }
        if (!allowed.includes(block.presentation)) problems.push(`${at}.presentation must be one of ${allowed.join(', ')} for ${block.type}`);

        if (block.type === 'prose') {
            if (!isString(block.content)) problems.push(`${at}.content must be a string`);
            if (block.presentation === 'lead' && CODE_FENCE.test(asText(block.content ?? ''))) problems.push(`${at}: the lead must not contain a code fence`);
        } else if (block.type === 'section') {
            if (!isString(block.title)) problems.push(`${at}.title must be a string`);
            if (!isString(block.content)) problems.push(`${at}.content must be a string`);
            if (typeof block.has_image !== 'boolean') problems.push(`${at}.has_image must be a boolean`);
        } else if (block.type === 'list') {
            if (!isString(block.title)) problems.push(`${at}.title must be a string`);
            if (!Array.isArray(block.items)) problems.push(`${at}.items must be an array`);
            else if (block.items.some(item => CODE_FENCE.test(asText(item)))) problems.push(`${at}: list items must not contain code fences`);
        }
    });
    return problems;
}

function main(argv) {
    const [file] = argv;
    if (!file) {
        process.stderr.write('Usage: check_article_json.js <article.json>\n');
        return 2;
    }
    let article;
    try { article = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) {
        process.stderr.write(`${file}: ${error.message}\n`);
        return 1;
    }
    const problems = check(article);
    if (problems.length) {
        process.stderr.write(`${file} is not a valid article:\n${problems.map(p => `  - ${p}`).join('\n')}\n`);
        return 1;
    }
    process.stdout.write(`${file} OK\n`);
    return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { check };
