#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// `dir` doubles as the output dir and the project dir, so a project map lands
// at <dir>/.rtfm/project_map.json and mockups at <dir>/block_<id>.html.
function run(article, { viewSources = { blocks: [] }, projectMap = null, files = {}, env = {} } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtfm-block-copy-'));
    fs.writeFileSync(path.join(dir, 'article.json'), JSON.stringify(article));
    fs.writeFileSync(path.join(dir, 'view_sources.json'), JSON.stringify(viewSources));
    if (projectMap) { fs.mkdirSync(path.join(dir, '.rtfm')); fs.writeFileSync(path.join(dir, '.rtfm', 'project_map.json'), JSON.stringify(projectMap)); }
    for (const [name, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true }); fs.writeFileSync(path.join(dir, name), text); }
    const result = spawnSync(process.execPath, [path.join(__dirname, 'lint_article_copy.js'), dir, dir], { encoding: 'utf8', env: { ...process.env, ...env } });
    const report = JSON.parse(fs.readFileSync(path.join(dir, 'article_lint_report.json'), 'utf8'));
    fs.rmSync(dir, { recursive: true, force: true });
    return { result, report };
}
const warningsOf = (check, id) => check.report.blocks.find(block => block.block_id === id).warnings;
const section = (id, content, extra = {}) => ({ id, type: 'section', presentation: 'numbered', title: 'Run it', content, has_image: false, ...extra });
const howTo = (...middle) => ({
    schema_version: 2, title: 'How to send a message', article_type: 'how-to',
    blocks: [
        { id: 'introduction', type: 'prose', presentation: 'lead', content: 'Send a message from the terminal.' },
        ...middle,
        { id: 'summary', type: 'prose', presentation: 'summary', title: 'Summary', content: 'The message is sent.' },
    ],
});
const FENCE = '```';

const concept = {
    schema_version: 2,
    title: 'What is Meetily?',
    article_type: 'concept',
    blocks: [
        { id: 'introduction', type: 'prose', presentation: 'lead', content: 'Meetily records and organises meetings.' },
        { id: 'how-it-works', type: 'section', presentation: 'plain', title: 'How it works', content: 'Meetily turns conversations into useful notes.', has_image: false },
        { id: 'summary', type: 'prose', presentation: 'summary', title: 'Summary', content: 'Use Meetily to keep meeting knowledge accessible.' },
    ],
};
let check = run(concept);
assert.strictEqual(check.result.status, 0, check.result.stdout + check.result.stderr);
assert.strictEqual(check.report.all_passed, true);
assert.deepStrictEqual(check.report.blocks.map(block => block.block_id), ['introduction', 'how-it-works', 'summary']);

check = run({ title: 'Legacy', article_type: 'how-to', introduction: 'Old', steps: [] });
assert.strictEqual(check.result.status, 1);
assert(check.report.global_errors.some(error => error.includes('schema_version')));

check = run({ ...concept, blocks: [...concept.blocks, { ...concept.blocks[1] }] });
assert.strictEqual(check.result.status, 1);
assert(check.report.global_errors.some(error => error.includes('duplicated')));

// ---- Fence placement is schema-hard ---------------------------------------
const leadFence = howTo(section('run', 'Run the command.'));
leadFence.blocks[0].content = `Install it first.\n${FENCE}bash\nnpm install\n${FENCE}`;
check = run(leadFence);
assert.strictEqual(check.result.status, 1);
assert(check.report.global_errors.some(error => error.includes('lead prose') && error.includes('fenced code block')));
check = run(leadFence, { env: { RTFM_LINT_MODE: 'warn' } });
assert.strictEqual(check.result.status, 1, 'fence placement stays hard under warn mode');

check = run(howTo(section('run', 'Run the command.'), { id: 'prerequisites', type: 'list', presentation: 'checklist', title: 'Prerequisites', items: ['Node installed', `${FENCE}\nnpm -v\n${FENCE}`] }));
assert.strictEqual(check.result.status, 1);
assert(check.report.global_errors.some(error => error.includes('items[1]') && error.includes('inline-only')));

check = run(howTo(section('run', `Run the command.\n${FENCE}bash\ntgt --help`)));
assert.strictEqual(check.result.status, 1);
assert(check.report.global_errors.some(error => error.includes('unclosed')));

// ---- Fences in sections and the summary are fine; code never counts as prose --
const fenced = howTo(section('run', `Open a terminal. Run the command below. Wait for it to finish.\n${FENCE}bash\necho a.b. c. d.\n${FENCE}`));
fenced.blocks[2].content = `Wrap up with:\n${FENCE}bash\ntgt --send-message "Alice" "Hi"\n${FENCE}`;
check = run(fenced);
assert.strictEqual(check.result.status, 0, check.result.stdout + check.result.stderr);
assert(!check.report.global_warnings.some(warning => warning.includes('exceeds')), JSON.stringify(check.report.global_warnings));
assert.deepStrictEqual(check.report.metrics, { inline_code_spans: 0, fenced_blocks: 2, untagged_fences: 0 });

check = run(howTo(section('run', `Run the command.\n${FENCE}\ntgt --help\n${FENCE}`)));
assert.strictEqual(check.result.status, 0);
assert(warningsOf(check, 'run').some(warning => warning.includes('without a language tag')));
assert(check.result.stdout.includes('[WARN] block run:'), 'block warnings are printed for the model');

check = run(howTo(section('run', `${FENCE}bash\ntgt --help\n${FENCE}\nThis prints the options.`)));
assert.strictEqual(check.result.status, 0);
assert(warningsOf(check, 'run').some(warning => warning.includes('starts with a code block')));

// ---- Code-as-bold probe ----------------------------------------------------
const terminalMap = { app_type: 'terminal', cli_metadata: { binary: 'tgt' } };
check = run(howTo(section('run', 'Run **tgt --help** and pass **--send-message**; edit **~/.config/tgt/config.toml**. Select **Send**.')), { projectMap: terminalMap });
assert.strictEqual(check.result.status, 0);
const bold = warningsOf(check, 'run');
assert(bold.some(warning => warning.includes('"tgt --help" looks like a command')), JSON.stringify(bold));
assert(bold.some(warning => warning.includes('"--send-message" looks like a flag')));
assert(bold.some(warning => warning.includes('config.toml" looks like a path')));
assert(bold.some(warning => warning.includes('bold UI name "Send"')), 'plain labels still go through the bold check');

check = run(howTo(section('run', 'Run **`tgt --help`**.')));
assert(warningsOf(check, 'run').some(warning => warning.includes('bolds inline code')));

// ---- Inline-code fidelity: warn only, dash/underscore-insensitive ----------
const sources = { blocks: [{ block_id: 'run', verbatim_evidence: ['send_message', 'Usage: tgt [OPTIONS]'] }] };
check = run(howTo(section('run', 'Pass `--send-message` to `tgt`, then try `--dry-run`.')), { viewSources: sources });
assert.strictEqual(check.result.status, 0);
const code = warningsOf(check, 'run');
assert(!code.some(warning => warning.includes('--send-message')), JSON.stringify(code));
assert(code.some(warning => warning.includes('"--dry-run" appears in none')), JSON.stringify(code));
assert(!code.some(warning => warning.includes('"tgt"')), 'plain single words are not grounded');
check = run(howTo(section('run', 'Try `--dry-run`.')));
assert.strictEqual(warningsOf(check, 'run').length, 0, 'no sources resolved, nothing to check against');

// ---- Redundant command screenshot on terminal projects ----------------------
const cmdOnly = '<div class="terminal-line"><span class="terminal-prompt">$</span><span class="terminal-cmd">tgt --help</span></div>';
check = run(howTo(section('run', 'Run the command.', { has_image: true })), { projectMap: terminalMap, files: { 'block_run.html': cmdOnly } });
assert(warningsOf(check, 'run').some(warning => warning.includes('spends a screenshot on a typed command')));
check = run(howTo(section('run', 'Run the command.', { has_image: true })), { projectMap: terminalMap, files: { 'block_run.html': cmdOnly + '<span class="terminal-output">Usage: tgt [OPTIONS]</span>' } });
assert(!warningsOf(check, 'run').some(warning => warning.includes('spends a screenshot')));
check = run(howTo(section('run', 'Run the command.', { has_image: true })), { files: { 'block_run.html': cmdOnly } });
assert(!warningsOf(check, 'run').some(warning => warning.includes('spends a screenshot')), 'web projects are not checked');

console.log('lint_article_copy block-contract tests passed');

// Structured generated evidence must pass both copy and screenshot source checks.
const generatedLabel = {string:'Create API key',found_in:'form.erb',generated:{kind:'rails_submit',locale:'en',action:'create',binding:'@record',binding_source:'controller.rb',model_source:'model.rb'}};
const generatedFiles = {
    'form.erb': '<%= form_with(model: @record) do |f| %><%= f.submit %><% end %>',
    'controller.rb': '@record = APIKey.new',
    'model.rb': 'class APIKey < ActiveRecord::Base\nend',
    'config/initializers/inflections.rb': "ActiveSupport::Inflector.inflections(:en) do |i|\n i.acronym 'API'\nend",
};
const generatedSources = {blocks:[{block_id:'create',primary_view:'form.erb',verbatim_evidence:[generatedLabel]}]};
check = run(howTo(section('create','Click **Create API key**.',{has_image:true})),{viewSources:generatedSources,files:generatedFiles});
assert.equal(check.result.status,0,JSON.stringify(check.report));
generatedLabel.string = 'Delete everything';
check = run(howTo(section('create','Click **Delete everything**.',{has_image:true})),{viewSources:generatedSources,files:generatedFiles});
assert.equal(check.result.status,1,'unverified generated claims must not enter the copy corpus');
