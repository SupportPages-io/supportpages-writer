#!/usr/bin/env node
'use strict';

/**
 * Generate raster assets for article/walkthrough mockups.
 *
 * Ordinary assets are content-only leaves inside source-grounded product UI.
 * The separately-authorised `external-surface` kind may depict a complete
 * non-product surface (for example an email or OS permission prompt) when its
 * exact visible copy is supplied in the request manifest.
 *
 * Input:  <out>/generated_image_requests.json
 * Output: <out>/generated_images.json + successful files in
 *         <out>/generated-assets/*
 * Cache:  .rtfm/generated-content/<sha256>.{png,json}
 *
 * Missing credentials and per-image API failures are recorded as failures and
 * produce no image file. Invalid request manifests are hard errors.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_ASSETS = 5;
const DEFAULT_MODEL = 'gpt-image-2';
const GENERATOR_VERSION = 1;
const SIZE_BY_ASPECT = {
    landscape: '1536x1024',
    portrait: '1024x1536',
    square: '1024x1024',
};
const ALLOWED_KINDS = new Set([
    'photo', 'portrait', 'video-frame', 'artwork', 'media-preview', 'external-surface',
]);
const ALLOWED_EXTERNAL_SURFACES = new Set([
    'confirmation-email',
    'invitation-email',
    'os-permission-dialog',
    'browser-permission-dialog',
    'push-notification',
    'document',
    'receipt',
    'third-party-consent',
]);
const ALLOWED_SOURCE_BASES = new Set(['repository', 'user-description', 'platform-convention']);
const CONTENT_GUARDRAIL = [
    'Generate only the content image that will appear inside an existing product interface.',
    'Do not draw application UI, controls, buttons, menus, dialogs, browser or device frames,',
    'screenshots, logos, watermarks, icons, charts, diagrams, file-type symbols, or legible text.',
    'Do not add a border or mockup frame. Fill the image edge to edge with the requested content.',
].join(' ');
const EXTERNAL_SURFACE_GUARDRAIL = [
    'Generate one straight-on, accurate representation of the named external surface encountered outside the product application.',
    'This request is authorised to contain interface elements and legible text only for that external surface.',
    'Do not draw, extend, or imitate the product application UI or product chrome.',
    'Do not place the surface in a device mockup, marketing scene, hand-held view, or perspective composition.',
    'Render every required string exactly as supplied, preserving spelling, punctuation, capitalisation, and word order.',
    'Do not paraphrase required text and do not invent additional names, legal copy, buttons, links, codes, dates, or customer data.',
].join(' ');

function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (!arg.startsWith('--')) continue;
        const key = arg.slice(2);
        const value = argv[i + 1];
        if (!value || value.startsWith('--')) {
            args[key] = true;
        } else {
            args[key] = value;
            i += 1;
        }
    }
    return args;
}

function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        throw new Error(`cannot read ${file}: ${error.message}`);
    }
}

function validateRequests(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new Error('request manifest must be a JSON object');
    }
    if (input.version !== 1) throw new Error('request manifest version must be 1');
    if (!Array.isArray(input.assets)) throw new Error('request manifest assets must be an array');
    if (input.assets.length > MAX_ASSETS) {
        throw new Error(`request manifest has ${input.assets.length} assets; maximum is ${MAX_ASSETS}`);
    }

    const ids = new Set();
    return input.assets.map((asset, index) => {
        const label = `assets[${index}]`;
        if (!asset || typeof asset !== 'object' || Array.isArray(asset)) {
            throw new Error(`${label} must be an object`);
        }
        if (typeof asset.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(asset.id)) {
            throw new Error(`${label}.id must be a lowercase kebab-case identifier`);
        }
        if (ids.has(asset.id)) throw new Error(`${label}.id duplicates '${asset.id}'`);
        ids.add(asset.id);
        if (!ALLOWED_KINDS.has(asset.kind)) {
            throw new Error(`${label}.kind must be one of ${[...ALLOWED_KINDS].join(', ')}`);
        }
        for (const field of ['purpose', 'reason', 'prompt', 'alt']) {
            if (typeof asset[field] !== 'string' || !asset[field].trim()) {
                throw new Error(`${label}.${field} must be a non-empty string`);
            }
        }
        if (!Object.hasOwn(SIZE_BY_ASPECT, asset.aspect_ratio)) {
            throw new Error(`${label}.aspect_ratio must be landscape, portrait, or square`);
        }
        const usesBlocks = Array.isArray(asset.used_in_blocks);
        if (usesBlocks) {
            if (!asset.used_in_blocks.length || asset.used_in_blocks.some(id => typeof id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id))) {
                throw new Error(`${label}.used_in_blocks must contain block ids`);
            }
        } else if (!Array.isArray(asset.used_in_steps) || asset.used_in_steps.length === 0 ||
            asset.used_in_steps.some(step => !Number.isInteger(step) || step < 0)) {
            throw new Error(`${label} requires used_in_blocks (article v2) or non-negative used_in_steps (legacy/walkthrough)`);
        }
        const validated = {
            id: asset.id,
            kind: asset.kind,
            purpose: asset.purpose.trim(),
            reason: asset.reason.trim(),
            prompt: asset.prompt.trim(),
            aspect_ratio: asset.aspect_ratio,
            alt: asset.alt.trim(),
            ...(usesBlocks
                ? { used_in_blocks: [...new Set(asset.used_in_blocks)].sort() }
                : { used_in_steps: [...new Set(asset.used_in_steps)].sort((a, b) => a - b) }),
        };
        if (asset.kind === 'external-surface') {
            if (!ALLOWED_EXTERNAL_SURFACES.has(asset.surface)) {
                throw new Error(`${label}.surface must be one of ${[...ALLOWED_EXTERNAL_SURFACES].join(', ')}`);
            }
            if (!ALLOWED_SOURCE_BASES.has(asset.source_basis)) {
                throw new Error(`${label}.source_basis must be one of ${[...ALLOWED_SOURCE_BASES].join(', ')}`);
            }
            if (!Array.isArray(asset.required_text) || asset.required_text.length === 0 ||
                asset.required_text.length > 20 || asset.required_text.some(text =>
                    typeof text !== 'string' || !text.trim() || text.length > 500)) {
                throw new Error(`${label}.required_text must contain 1-20 non-empty strings of at most 500 characters`);
            }
            const requiredText = asset.required_text.map(text => text.trim());
            if (new Set(requiredText).size !== requiredText.length) {
                throw new Error(`${label}.required_text must not contain duplicates`);
            }
            if (!Array.isArray(asset.source_files) || asset.source_files.some(file =>
                typeof file !== 'string' || !file.trim() || path.isAbsolute(file) || file.split(/[\\/]/).includes('..'))) {
                throw new Error(`${label}.source_files must be an array of safe project-relative paths`);
            }
            if (asset.source_basis === 'repository' && asset.source_files.length === 0) {
                throw new Error(`${label}.source_files must not be empty when source_basis is repository`);
            }
            validated.surface = asset.surface;
            validated.source_basis = asset.source_basis;
            validated.source_files = [...new Set(asset.source_files.map(file => file.trim()))];
            validated.required_text = requiredText;
        } else if (asset.surface !== undefined || asset.source_basis !== undefined ||
            asset.source_files !== undefined || asset.required_text !== undefined) {
            throw new Error(`${label} external-surface fields are only valid when kind is external-surface`);
        }
        return validated;
    });
}

function buildPrompt(asset) {
    if (asset.kind === 'external-surface') {
        const required = asset.required_text.map((text, index) => `${index + 1}. ${JSON.stringify(text)}`).join('\n');
        return [
            asset.prompt,
            '',
            `External surface type: ${asset.surface}.`,
            `Source basis: ${asset.source_basis}.`,
            'Required visible text (render verbatim):',
            required,
            '',
            EXTERNAL_SURFACE_GUARDRAIL,
        ].join('\n');
    }
    const fictionalPeople = ['portrait', 'video-frame'].includes(asset.kind)
        ? ' Any depicted person must be fictional and must not depict or imitate an identifiable real person.'
        : '';
    return `${asset.prompt}\n\n${CONTENT_GUARDRAIL}${fictionalPeople}`;
}

function cacheKey({ prompt, model, size }) {
    return crypto.createHash('sha256')
        .update(JSON.stringify({ version: GENERATOR_VERSION, prompt, model, size }))
        .digest('hex');
}

function decodeImagePayload(json) {
    if (!json || !Array.isArray(json.data) || json.data.length === 0) {
        throw new Error('OpenAI response is missing data[]');
    }
    const item = json.data[0];
    if (item && item.b64_json) return { bytes: Buffer.from(item.b64_json, 'base64'), url: null };
    if (item && item.url) return { bytes: null, url: item.url };
    throw new Error('OpenAI response is missing b64_json/url');
}

async function callOpenAI({ apiKey, model, prompt, size, fetchImpl = globalThis.fetch, apiBase }) {
    if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable; Node.js 18+ is required');
    const base = (apiBase || process.env.OPENAI_API_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
    const response = await fetchImpl(`${base}/images/generations`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model, prompt, size, n: 1 }),
    });
    if (!response.ok) {
        const body = await response.text().catch(() => '<no response body>');
        throw new Error(`OpenAI images API returned ${response.status}: ${body.slice(0, 400)}`);
    }
    const decoded = decodeImagePayload(await response.json());
    if (decoded.bytes) return decoded.bytes;
    const imageResponse = await fetchImpl(decoded.url);
    if (!imageResponse.ok) throw new Error(`generated image download returned ${imageResponse.status}`);
    return Buffer.from(await imageResponse.arrayBuffer());
}

async function generateAll({ requests, outDir, cacheDir, model = DEFAULT_MODEL, apiKey,
    fetchImpl = globalThis.fetch, apiBase }) {
    const assets = validateRequests(requests);
    const generatedDir = path.join(outDir, 'generated-assets');
    fs.rmSync(generatedDir, { recursive: true, force: true });
    fs.mkdirSync(generatedDir, { recursive: true });
    fs.mkdirSync(cacheDir, { recursive: true });
    const results = {};
    const failures = {};

    for (const asset of assets) {
        const prompt = buildPrompt(asset);
        const size = SIZE_BY_ASPECT[asset.aspect_ratio];
        const hash = cacheKey({ prompt, model, size });
        const cachePng = path.join(cacheDir, `${hash}.png`);
        const outputPng = path.join(generatedDir, `${asset.id}.png`);
        let result;
        let failure;

        if (fs.existsSync(cachePng) && fs.statSync(cachePng).size > 0) {
            fs.copyFileSync(cachePng, outputPng);
            result = { status: 'cached', filename: `${asset.id}.png`, mime: 'image/png' };
        } else if (!apiKey) {
            failure = {
                status: 'failed',
                warning: 'OPENAI_API_KEY is not set; no image was produced',
            };
        } else {
            try {
                const bytes = await callOpenAI({ apiKey, model, prompt, size, fetchImpl, apiBase });
                if (!bytes.length) throw new Error('OpenAI returned an empty image');
                fs.writeFileSync(cachePng, bytes);
                fs.copyFileSync(cachePng, outputPng);
                result = { status: 'generated', filename: `${asset.id}.png`, mime: 'image/png' };
                fs.writeFileSync(path.join(cacheDir, `${hash}.json`), JSON.stringify({
                    version: GENERATOR_VERSION, hash, model, size, generated_at: new Date().toISOString(),
                }, null, 2));
            } catch (error) {
                failure = {
                    status: 'failed',
                    warning: `image generation failed; no image was produced: ${error.message}`,
                };
            }
        }

        const ledger = {
            kind: asset.kind,
            purpose: asset.purpose,
            reason: asset.reason,
            alt: asset.alt,
            aspect_ratio: asset.aspect_ratio,
            ...(asset.used_in_blocks ? { used_in_blocks: asset.used_in_blocks } : { used_in_steps: asset.used_in_steps }),
            model,
            size,
            prompt_hash: hash,
        };
        if (asset.kind === 'external-surface') {
            ledger.surface = asset.surface;
            ledger.source_basis = asset.source_basis;
            ledger.source_files = asset.source_files;
            ledger.required_text = asset.required_text;
            ledger.text_fidelity = {
                enforcement: 'prompt-constrained',
                required_text_count: asset.required_text.length,
            };
        }
        if (failure) {
            failures[asset.id] = { ...failure, ...ledger };
            console.error(`  ${asset.id}: failed (${failure.warning})`);
        } else {
            results[asset.id] = {
                ...result,
                path: `generated-assets/${result.filename}`,
                ...ledger,
            };
            console.error(`  ${asset.id}: ${result.status}`);
        }
    }

    if (Object.keys(results).length === 0) {
        fs.rmSync(generatedDir, { recursive: true, force: true });
    }

    const manifest = {
        version: 1,
        max_assets: MAX_ASSETS,
        requested_count: assets.length,
        count: Object.keys(results).length,
        failure_count: Object.keys(failures).length,
        model,
        assets: results,
        failures,
    };
    fs.writeFileSync(path.join(outDir, 'generated_images.json'), JSON.stringify(manifest, null, 2));
    return manifest;
}

async function main(argv = process.argv.slice(2)) {
    const args = parseArgs(argv);
    if (!args.requests || !args.out) {
        console.error('Usage: generate_content_images.js --requests <json> --out <dir> [--cache <dir>] [--model <model>]');
        return 2;
    }
    let requests;
    try {
        requests = readJson(args.requests);
        const model = args.model || process.env.OPENAI_IMAGE_MODEL || DEFAULT_MODEL;
        const cacheDir = args.cache || './.rtfm/generated-content';
        const manifest = await generateAll({
            requests,
            outDir: args.out,
            cacheDir,
            model,
            apiKey: process.env.OPENAI_API_KEY || '',
        });
        console.error(
            `${manifest.requested_count} generated image request(s) processed; ` +
            `${manifest.count} image(s) available; ${manifest.failure_count} failure(s) omitted`
        );
        return 0;
    } catch (error) {
        console.error(`ERROR: ${error.message}`);
        return 1;
    }
}

if (require.main === module) {
    main().then(code => { process.exitCode = code; });
}

module.exports = {
    ALLOWED_KINDS,
    ALLOWED_EXTERNAL_SURFACES,
    ALLOWED_SOURCE_BASES,
    MAX_ASSETS,
    SIZE_BY_ASPECT,
    buildPrompt,
    cacheKey,
    callOpenAI,
    decodeImagePayload,
    generateAll,
    main,
    validateRequests,
};
