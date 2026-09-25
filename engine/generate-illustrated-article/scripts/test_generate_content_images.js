#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
    MAX_ASSETS,
    buildPrompt,
    generateAll,
    validateRequests,
} = require('./generate_content_images.js');

function request(overrides = {}) {
    return {
        id: 'participant-alex',
        kind: 'video-frame',
        purpose: 'A fictional participant visible inside the real call tile',
        reason: 'The source requires a live camera feed and provides no suitable image asset',
        prompt: 'Natural webcam view of a fictional adult in a bright home office',
        aspect_ratio: 'landscape',
        alt: 'Fictional participant on camera',
        used_in_steps: [1, 2],
        ...overrides,
    };
}

function manifest(assets = [request()]) { return { version: 1, assets }; }

function externalRequest(overrides = {}) {
    return request({
        id: 'confirm-email',
        kind: 'external-surface',
        surface: 'confirmation-email',
        source_basis: 'user-description',
        source_files: [],
        required_text: ['Confirm your email address', 'Confirm email'],
        purpose: 'The confirmation email the reader must recognise and act in',
        reason: 'The step happens outside the product and no renderable email template exists',
        prompt: 'A clean transactional confirmation email on a neutral mail canvas',
        alt: 'Confirmation email with a Confirm email button',
        used_in_steps: [2],
        ...overrides,
    });
}

async function run() {
    assert.strictEqual(validateRequests(manifest()).length, 1);
    const blockAsset = validateRequests(manifest([request({ used_in_steps: undefined, used_in_blocks: ['join-call'] })]))[0];
    assert.deepStrictEqual(blockAsset.used_in_blocks, ['join-call']);
    assert.throws(() => validateRequests(manifest(Array.from({ length: MAX_ASSETS + 1 }, (_, i) =>
        request({ id: `asset-${i}` })))), /maximum is 5/);
    assert.throws(() => validateRequests(manifest([request(), request()])), /duplicates/);
    assert.throws(() => validateRequests(manifest([request({ kind: 'ui-mockup' })])), /kind must be/);
    assert.strictEqual(validateRequests(manifest([externalRequest()]))[0].surface, 'confirmation-email');
    assert.throws(() => validateRequests(manifest([externalRequest({ surface: 'product-screen' })])), /surface must be/);
    assert.throws(() => validateRequests(manifest([externalRequest({ required_text: [] })])), /required_text/);
    assert.throws(() => validateRequests(manifest([externalRequest({ source_basis: 'repository', source_files: [] })])), /must not be empty/);
    assert.throws(() => validateRequests(manifest([request({ required_text: ['Not allowed'] })])), /only valid/);

    const prompt = buildPrompt(request());
    assert(prompt.includes('Do not draw application UI'));
    assert(prompt.includes('must not depict or imitate an identifiable real person'));

    const externalPrompt = buildPrompt(validateRequests(manifest([externalRequest()]))[0]);
    assert(externalPrompt.includes('External surface type: confirmation-email'));
    assert(externalPrompt.includes('"Confirm your email address"'));
    assert(externalPrompt.includes('authorised to contain interface elements and legible text'));
    assert(externalPrompt.includes('Do not draw, extend, or imitate the product application UI'));

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rtfm-content-images-'));
    const out = path.join(root, 'out');
    const cache = path.join(root, 'cache');
    let calls = 0;
    const fakeFetch = async () => {
        calls += 1;
        return {
            ok: true,
            json: async () => ({ data: [{ b64_json: Buffer.from('fake-png').toString('base64') }] }),
        };
    };

    let result = await generateAll({ requests: manifest(), outDir: out, cacheDir: cache,
        apiKey: 'test-key', fetchImpl: fakeFetch });
    assert.strictEqual(result.assets['participant-alex'].status, 'generated');
    assert.strictEqual(calls, 1);
    assert.strictEqual(fs.readFileSync(path.join(out, 'generated-assets', 'participant-alex.png'), 'utf8'), 'fake-png');

    result = await generateAll({ requests: manifest(), outDir: out, cacheDir: cache,
        apiKey: 'test-key', fetchImpl: fakeFetch });
    assert.strictEqual(result.assets['participant-alex'].status, 'cached');
    assert.strictEqual(calls, 1);

    result = await generateAll({ requests: manifest(), outDir: out, cacheDir: cache,
        model: 'gpt-image-1', apiKey: 'test-key', fetchImpl: fakeFetch });
    assert.strictEqual(result.assets['participant-alex'].status, 'generated');
    assert.strictEqual(calls, 2);

    const externalOut = path.join(root, 'external');
    result = await generateAll({ requests: manifest([externalRequest()]), outDir: externalOut,
        cacheDir: path.join(root, 'external-cache'), apiKey: 'test-key', fetchImpl: fakeFetch });
    assert.strictEqual(result.assets['confirm-email'].status, 'generated');
    assert.strictEqual(result.assets['confirm-email'].surface, 'confirmation-email');
    assert.deepStrictEqual(result.assets['confirm-email'].required_text,
        ['Confirm your email address', 'Confirm email']);
    assert.deepStrictEqual(result.assets['confirm-email'].text_fidelity,
        { enforcement: 'prompt-constrained', required_text_count: 2 });

    const missingKeyOut = path.join(root, 'missing-key');
    result = await generateAll({ requests: manifest(), outDir: missingKeyOut, cacheDir: path.join(root, 'empty-cache'),
        apiKey: '' });
    assert.strictEqual(result.count, 0);
    assert.strictEqual(result.failure_count, 1);
    assert.strictEqual(result.assets['participant-alex'], undefined);
    assert.strictEqual(result.failures['participant-alex'].status, 'failed');
    assert(result.failures['participant-alex'].warning.includes('no image was produced'));
    assert(!fs.existsSync(path.join(missingKeyOut, 'generated-assets')));

    const failedOut = path.join(root, 'api-failure');
    const failedFetch = async () => ({ ok: false, status: 429, text: async () => 'rate limited' });
    result = await generateAll({ requests: manifest(), outDir: failedOut, cacheDir: path.join(root, 'failed-cache'),
        apiKey: 'test-key', fetchImpl: failedFetch });
    assert.strictEqual(result.count, 0);
    assert.strictEqual(result.failure_count, 1);
    assert.strictEqual(result.assets['participant-alex'], undefined);
    assert(result.failures['participant-alex'].warning.includes('429'));
    assert(result.failures['participant-alex'].warning.includes('no image was produced'));
    assert(!fs.existsSync(path.join(failedOut, 'generated-assets')));

    const injectOut = path.join(root, 'inject');
    fs.mkdirSync(injectOut, { recursive: true });
    fs.writeFileSync(path.join(injectOut, 'step_0.html'),
        '<!doctype html><html><head><!-- INJECT_CSS --></head><body><img src="{{generated:participant-alex}}" data-rtfm-generated-asset="participant-alex"></body></html>');
    fs.writeFileSync(path.join(injectOut, 'images.json'), JSON.stringify({ images: {} }));
    fs.copyFileSync(path.join(out, 'generated_images.json'), path.join(injectOut, 'generated_images.json'));
    fs.cpSync(path.join(out, 'generated-assets'), path.join(injectOut, 'generated-assets'), { recursive: true });
    const injected = spawnSync(process.execPath, [path.join(__dirname, 'inject_assets.js'), injectOut, '',
        path.join(injectOut, 'images.json'), '--generated-images', path.join(injectOut, 'generated_images.json')],
    { encoding: 'utf8' });
    assert.strictEqual(injected.status, 0, injected.stdout + injected.stderr);
    const injectedHtml = fs.readFileSync(path.join(injectOut, 'step_0.html'), 'utf8');
    assert(injectedHtml.includes('src="data:image/png;base64,'));
    assert(injectedHtml.includes('data-rtfm-generated-asset="participant-alex"'));

    const omittedInjectOut = path.join(root, 'inject-omitted');
    fs.mkdirSync(omittedInjectOut, { recursive: true });
    fs.writeFileSync(path.join(omittedInjectOut, 'step_0.html'),
        '<!doctype html><html><head><!-- INJECT_CSS --></head><body><img src="{{generated:participant-alex}}" data-rtfm-generated-asset="participant-alex"></body></html>');
    fs.writeFileSync(path.join(omittedInjectOut, 'images.json'), JSON.stringify({ images: {} }));
    fs.copyFileSync(path.join(missingKeyOut, 'generated_images.json'), path.join(omittedInjectOut, 'generated_images.json'));
    const omittedInjection = spawnSync(process.execPath, [path.join(__dirname, 'inject_assets.js'), omittedInjectOut, '',
        path.join(omittedInjectOut, 'images.json'), '--generated-images', path.join(omittedInjectOut, 'generated_images.json')],
    { encoding: 'utf8' });
    assert.strictEqual(omittedInjection.status, 0, omittedInjection.stdout + omittedInjection.stderr);
    const omittedHtml = fs.readFileSync(path.join(omittedInjectOut, 'step_0.html'), 'utf8');
    assert(omittedHtml.includes('src="{{generated:participant-alex}}"'));
    assert(!omittedHtml.includes('src="data:image/'));

    fs.rmSync(root, { recursive: true, force: true });
    console.log('content image generation tests passed');
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
