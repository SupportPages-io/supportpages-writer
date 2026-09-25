#!/usr/bin/env node
/**
 * source_paths.js — cited source paths: project-relative always; `../<repo>/…`
 * only with RTFM_REPOS_ROOT set, only into a git checkout beside the project,
 * never escaping that checkout (nested `..`, symlinks, the root itself, a
 * non-repo dir, the project itself). Plus label evidence found in a sibling.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function write(root, rel, text) { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); }

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'source-paths-')));
const web = path.join(root, 'acme-web');
fs.mkdirSync(path.join(web, '.git'), { recursive: true });
fs.mkdirSync(path.join(root, 'acme-api', '.git'), { recursive: true });
write(web, 'app/views/plans/index.html.erb', '<h1>Plans</h1>');
write(root, 'acme-api/config/locales/en.yml', 'en:\n  limit_reached: "You have reached your plan limit"\n');
write(root, 'notes/readme.md', 'not a repo');
write(root, 'secret.txt', 'outside every checkout');
fs.symlinkSync(path.join(root, 'secret.txt'), path.join(root, 'acme-api', 'leak.txt'));

delete process.env.RTFM_REPOS_ROOT;
const load = () => { for (const m of ['./source_paths.js', './label_evidence.js']) delete require.cache[require.resolve(m)]; return require('./source_paths.js'); };

// Without RTFM_REPOS_ROOT: the strict single-repo rule.
let sp = load();
assert.ok(sp.isSafeSourcePath('app/views/plans/index.html.erb'));
assert.ok(!sp.isSafeSourcePath('../acme-api/config/locales/en.yml'));
assert.ok(!sp.isSafeSourcePath('/etc/passwd'));
assert.ok(!sp.isSafeSourcePath(''));
assert.strictEqual(sp.resolveSourcePath(web, 'app/views/plans/index.html.erb'), path.join(web, 'app/views/plans/index.html.erb'));
assert.throws(() => sp.resolveSourcePath(web, '../acme-api/config/locales/en.yml'), /project-relative/);

// With RTFM_REPOS_ROOT: one leading `..` into a sibling checkout.
process.env.RTFM_REPOS_ROOT = root;
sp = load();
assert.ok(sp.isSafeSourcePath('../acme-api/config/locales/en.yml'));
assert.ok(!sp.isSafeSourcePath('../acme-api/../secret.txt'));
assert.ok(!sp.isSafeSourcePath('app/../../secret.txt'));
assert.ok(!sp.isSafeSourcePath('../secret.txt'));
assert.strictEqual(sp.resolveSourcePath(web, '../acme-api/config/locales/en.yml'), path.join(root, 'acme-api/config/locales/en.yml'));
assert.ok(sp.sourceExists(web, '../acme-api/config/locales/en.yml'));
assert.ok(!sp.sourceExists(web, '../acme-api/missing.yml'));
assert.throws(() => sp.resolveSourcePath(web, '../notes/readme.md'), /not a related repository/);
assert.throws(() => sp.resolveSourcePath(web, '../acme-web/app/views/plans/index.html.erb'), /not a related repository/);
assert.throws(() => sp.resolveSourcePath(web, '../acme-api/leak.txt'), /outside the project/);

// A project dir that isn't a direct child of the root can't reach siblings.
const nested = path.join(root, 'acme-api', 'nested');
fs.mkdirSync(nested);
assert.throws(() => sp.resolveSourcePath(nested, '../acme-web/app/views/plans/index.html.erb'), /inside RTFM_REPOS_ROOT/);

// Label evidence found in a related repository verifies against that file.
const { verifyLabelEvidence } = require('./label_evidence.js');
assert.deepStrictEqual(
    verifyLabelEvidence({ string: 'You have reached your plan limit', found_in: '../acme-api/config/locales/en.yml' }, 'app/views/plans/index.html.erb', web),
    { ok: true, kind: 'literal' }
);
assert.strictEqual(verifyLabelEvidence({ string: 'Nope', found_in: '../acme-api/config/locales/en.yml' }, null, web).ok, false);
assert.strictEqual(verifyLabelEvidence({ string: 'outside', found_in: '../acme-api/leak.txt' }, null, web).ok, false);

delete process.env.RTFM_REPOS_ROOT;
fs.rmSync(root, { recursive: true, force: true });
console.log('test_source_paths: ok');
