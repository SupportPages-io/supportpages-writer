#!/usr/bin/env node
/**
 * related_repos.sh — the sibling-repository listing of a multi-repo product:
 * silent when RTFM_REPOS_ROOT is unset or holds only the anchor, one `../<dir>`
 * line per other checkout (non-repo dirs skipped, the anchor excluded), roles
 * and surfaces joined from RTFM_REPO_RELATIONSHIPS, and a broken relationships file never
 * failing the listing.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'related_repos.sh');

function repo(root, dir) { fs.mkdirSync(path.join(root, dir, '.git'), { recursive: true }); return path.join(root, dir); }
function run(env, cwd) {
    const base = { ...process.env };
    delete base.RTFM_REPOS_ROOT; delete base.RTFM_WORKSPACE; delete base.RTFM_REPO_RELATIONSHIPS;
    return execFileSync('bash', [SCRIPT], { encoding: 'utf8', cwd, env: { ...base, ...env } });
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'related-repos-'));
const web = repo(root, 'acme-web');

// Single repo: nothing to list, with or without RTFM_REPOS_ROOT.
assert.strictEqual(run({}, web), '');
assert.strictEqual(run({ RTFM_REPOS_ROOT: root, RTFM_WORKSPACE: web }, root), '');

// Three repos plus a stray non-repo dir: the two siblings, sorted, anchor excluded.
repo(root, 'acme-api');
repo(root, 'acme-mobile');
fs.mkdirSync(path.join(root, 'scratch'));
assert.strictEqual(run({ RTFM_REPOS_ROOT: root, RTFM_WORKSPACE: web }, root), '../acme-api\n../acme-mobile\n');

// Anchor defaults to cwd when RTFM_WORKSPACE is unset.
assert.strictEqual(run({ RTFM_REPOS_ROOT: root }, web), '../acme-api\n../acme-mobile\n');

// Roles from the relationships file; a repo it doesn't describe prints bare.
const rels = path.join(root, 'rels.json');
fs.writeFileSync(rels, JSON.stringify({
    repositories: [
        { directory: 'acme-web', role: 'Web app' },
        { directory: 'acme-api', role: 'Backend  API\nserver', surface: 'none' },
        { directory: 'acme-mobile', surface: 'mobile' },
    ],
}));
assert.strictEqual(
    run({ RTFM_REPOS_ROOT: root, RTFM_WORKSPACE: web, RTFM_REPO_RELATIONSHIPS: rels }, root),
    '../acme-api\tBackend API server\tnone\n../acme-mobile\t\tmobile\n'
);

// A corrupt or missing relationships file degrades to bare lines.
fs.writeFileSync(rels, '{not json');
assert.strictEqual(run({ RTFM_REPOS_ROOT: root, RTFM_WORKSPACE: web, RTFM_REPO_RELATIONSHIPS: rels }, root), '../acme-api\n../acme-mobile\n');
assert.strictEqual(run({ RTFM_REPOS_ROOT: root, RTFM_WORKSPACE: web, RTFM_REPO_RELATIONSHIPS: '/nope.json' }, root), '../acme-api\n../acme-mobile\n');

// A root that doesn't exist is silent, not an error.
assert.strictEqual(run({ RTFM_REPOS_ROOT: path.join(root, 'missing'), RTFM_WORKSPACE: web }, root), '');

fs.rmSync(root, { recursive: true, force: true });
console.log('test_related_repos: ok');
