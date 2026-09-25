#!/usr/bin/env node
/**
 * classify_surface.sh — surface vs code-only repositories: a full-stack Rails
 * app and an Express app with views are web; Rails API mode, an Express JSON
 * API and a Go library are none (mailer templates and test fixtures don't
 * count as an interface); a cobra CLI stays terminal and a React Native app
 * mobile; a frontend framework dependency alone is enough for web.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'classify_surface.sh');

function write(root, rel, text = '') { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); }
function classify(files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'surface-'));
    for (const [rel, text] of Object.entries(files)) write(root, rel, text);
    const out = execFileSync('bash', [SCRIPT, root], { encoding: 'utf8' });
    fs.rmSync(root, { recursive: true, force: true });
    return Object.fromEntries(out.trim().split('\n').map(line => line.split(/=(.*)/s).slice(0, 2)));
}
const RAILS = { Gemfile: "gem 'rails'\n", 'config/routes.rb': 'Rails.application.routes.draw do\nend\n' };

// Full-stack Rails: views are an interface.
assert.strictEqual(classify({
    ...RAILS,
    'app/views/layouts/application.html.erb': '<html></html>',
    'app/views/plans/index.html.erb': '<h1>Plans</h1>',
    'app/assets/stylesheets/application.css': 'body {}',
}).surface, 'web');

// Rails API mode, even with mailer templates.
let r = classify({
    ...RAILS,
    'config/application.rb': 'module App\n  class Application < Rails::Application\n    config.api_only = true\n  end\nend\n',
    'app/views/user_mailer/welcome.html.erb': '<p>Hi</p>',
});
assert.strictEqual(r.surface, 'none');
assert.strictEqual(r.source, 'auto');
assert.match(r.reason, /api_only/);

// Rails without api_only whose only templates are mailers and test fixtures: no interface.
assert.strictEqual(classify({
    ...RAILS,
    'app/views/user_mailer/welcome.html.erb': '<p>Hi</p>',
    'app/views/user_mailer/reset.html.erb': '<p>Reset</p>',
    'test/fixtures/files/page.html': '<p>x</p>',
    'spec/support/page.html': '<p>x</p>',
}).surface, 'none');

// Express JSON API vs Express app with views.
const EXPRESS = { 'package.json': JSON.stringify({ dependencies: { express: '^4' } }), 'src/server.js': 'app.get("/api", ...)' };
r = classify(EXPRESS);
assert.strictEqual(r.surface, 'none');
assert.strictEqual(r.source, 'auto');
assert.strictEqual(classify({ ...EXPRESS, 'views/index.ejs': '<h1/>', 'views/login.ejs': '<form/>', 'public/app.css': 'a{}' }).surface, 'web');

// A frontend framework dependency alone is an interface (templates may live in .js).
assert.strictEqual(classify({ 'package.json': JSON.stringify({ dependencies: { vue: '^3' } }) }).surface, 'web');

// Go library: nothing to classify, nothing to depict.
r = classify({ 'go.mod': 'module example.com/lib\n', 'lib.go': 'package lib\n' });
assert.strictEqual(r.surface, 'none');
assert.strictEqual(r.source, 'default');

// Non-web verdicts are interfaces as they stand.
assert.strictEqual(classify({ 'go.mod': 'module example.com/cli\n\nrequire github.com/spf13/cobra v1.8.0\n', 'main.go': 'package main\n' }).surface, 'terminal');
assert.strictEqual(classify({ 'package.json': JSON.stringify({ dependencies: { 'react-native': '0.74.0' } }) }).surface, 'mobile');

// A Node CLI with no CLI framework (the SupportPages Writer shape): a bin, an
// MCP server dependency and vendored engine templates/styles is terminal.
r = classify({
    'package.json': JSON.stringify({ bin: { writer: 'scripts/cli.mjs' }, dependencies: { '@modelcontextprotocol/sdk': '^1', '@clack/prompts': '1.6.0' } }),
    'scripts/cli.mjs': '#!/usr/bin/env node',
    'engine/detect-project/assets/tailwind-fallback.css': 'a{}',
    'engine/detect-project/assets/webtui.css': 'b{}',
    'engine/generate-illustrated-article/templates/page.html': '<html/>',
    'engine/generate-illustrated-article/templates/step.html': '<html/>',
    '.rtfm/branding.css': 'x{}', '.rtfm/previews/a.html': '<p/>', 'output/articles/x/block_a.html': '<p/>', 'output/articles/x/branding.css': 'y{}',
});
assert.strictEqual(r.surface, 'terminal');
assert.match(r.reason, /bin/);
// A bin beside a frontend framework is still a web app (e.g. a dev-server CLI).
assert.strictEqual(classify({ 'package.json': JSON.stringify({ bin: { app: 'cli.js' }, dependencies: { 'react-dom': '^18' } }) }).surface, 'web');
// A Node web app with its own views that also ships a bin stays web.
assert.strictEqual(classify({ ...EXPRESS, 'package.json': JSON.stringify({ bin: { app: 'bin/app' }, dependencies: { express: '^4' } }),
    'views/index.ejs': '<h1/>', 'views/login.ejs': '<form/>', 'public/app.css': 'a{}' }).surface, 'web');
// Vendored assets alone never make a server a web app.
assert.strictEqual(classify({ ...EXPRESS, 'engine/a.css': 'a{}', 'engine/b.css': 'b{}', 'third_party/c.html': '<p/>' }).surface, 'none');

// A missing directory is none, not an error.
assert.strictEqual(execFileSync('bash', [SCRIPT, '/nonexistent/dir'], { encoding: 'utf8' }).split('\n')[0], 'surface=none');

// classify_workspace.js: every checkout under a root, sorted, non-repos skipped.
const { classifyWorkspace } = require('./classify_workspace.js');
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'surface-ws-'));
write(ws, 'acme-web/.git/HEAD'); write(ws, 'acme-web/package.json', JSON.stringify({ dependencies: { 'react-dom': '^18' } }));
write(ws, 'acme-api/.git/HEAD'); write(ws, 'acme-api/package.json', JSON.stringify({ dependencies: { express: '^4' } }));
write(ws, 'notes/readme.md', 'not a repo');
assert.deepStrictEqual(classifyWorkspace(ws).map(r => [r.directory, r.surface]), [['acme-api', 'none'], ['acme-web', 'web']]);
assert.deepStrictEqual(classifyWorkspace(path.join(ws, 'missing')), []);
fs.rmSync(ws, { recursive: true, force: true });

console.log('classify_surface tests passed');
