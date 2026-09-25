import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fixture, article, png } from './helpers.mjs';
import { snapshot } from '../dist/artifacts.js';
import { renderMarkdown, exportArticle } from '../dist/export.js';
import { composeWritingStyle, writingStylePresets } from '../dist/writing-style.js';
import { localSchema } from '../dist/schema.js';

const full = { schema_version: 2, title: 'How to invite a teammate', article_type: 'how-to', blocks: [
  { id: 'intro', type: 'prose', presentation: 'lead', content: 'Invite someone to your workspace.' },
  { id: 'prereqs', type: 'list', presentation: 'checklist', title: 'Prerequisites', items: ['An admin role', ''] },
  { id: 'open', type: 'section', presentation: 'numbered', title: 'Open [Settings]', content: 'Select **Settings**.', has_image: false },
  { id: 'invite', type: 'section', presentation: 'numbered', title: 'Send the invitation', content: 'Select **Invite**.', has_image: true },
  { id: 'about', type: 'section', presentation: 'plain', title: 'About roles', content: 'Roles limit access.', has_image: false },
  { id: 'tips', type: 'list', presentation: 'tips', title: 'Tips', items: ['Invite in bulk.', 'Resend later.'] },
  { id: 'summary', type: 'prose', presentation: 'summary', content: 'Your teammate receives an email.' },
] };

test('markdown rendering gives every block a heading, numbers task steps and references images beside the file', async t => {
  const f = await fixture(t); await f.output(full);
  const snap = await snapshot(f.ws, 'output/articles/invite');
  const markdown = renderMarkdown(snap);
  assert.equal(markdown, [
    '# How to invite a teammate', 'Invite someone to your workspace.',
    '## Prerequisites', '- [ ] An admin role',
    '## 1. Open [Settings]', 'Select **Settings**.',
    '## 2. Send the invitation', 'Select **Invite**.', '![Send the invitation](./block_invite.png)',
    '## About roles', 'Roles limit access.',
    '## Tips', '> **Tip:** Invite in bulk.\n>\n> **Tip:** Resend later.',
    '## Summary', 'Your teammate receives an email.',
  ].join('\n\n') + '\n');
});

test('exporting into the artifact directory writes only the markdown, with world-readable modes', async t => {
  const f = await fixture(t); await f.output();
  const snap = await snapshot(f.ws, 'output/articles/invite');
  const result = await exportArticle(f.ws, snap, 'output/articles/invite', 'output/articles', 'invite');
  assert.equal(result.markdown_path, path.join(f.root, 'output/articles/invite/index.md'));
  assert.equal(result.image_count, 1);
  assert.match(await readFile(result.markdown_path, 'utf8'), /\[Send the invitation\]\(\.\/block_invite\.png\)/);
  assert.equal((await stat(result.markdown_path)).mode & 0o044, 0o044);
  assert.deepEqual((await readdir(path.join(f.root, 'output/articles/invite'))).sort(), ['article.json', 'block_invite.png', 'index.md', 'lint_report.json']);
});

test('exporting to a docs folder copies the current screenshots and removes stale ones on re-export', async t => {
  const f = await fixture(t); await f.output();
  await f.ws.write('docs/help/invite/block_old.png', png);
  const snap = await snapshot(f.ws, 'output/articles/invite');
  const result = await exportArticle(f.ws, snap, 'output/articles/invite', 'docs/help', 'invite');
  assert.equal(result.export_dir, path.join(f.root, 'docs/help/invite'));
  assert.deepEqual((await readdir(result.export_dir)).sort(), ['block_invite.png', 'index.md']);
  assert.equal((await stat(path.join(result.export_dir, 'block_invite.png'))).mode & 0o044, 0o044);
  await assert.rejects(exportArticle(f.ws, snap, 'output/articles/invite', '../outside', 'invite'), { code: 'invalid_path' });
  await assert.rejects(exportArticle(f.ws, snap, 'output/articles/invite', '/tmp', 'invite'), { code: 'invalid_path' });
});

test('writing-style presets expand to guidance and custom guidance passes through verbatim', () => {
  assert.deepEqual(Object.keys(writingStylePresets), ['friendly', 'minimal', 'technical', 'formal']);
  assert.match(composeWritingStyle('minimal'), /^Voice: terse quick-reference/);
  assert.match(composeWritingStyle(' Formal '), /no contractions/);
  assert.equal(composeWritingStyle(undefined), composeWritingStyle('friendly'));
  assert.equal(composeWritingStyle('Write like a pirate.'), 'Write like a pirate.');
  assert.equal(localSchema.parse({ version: 1, export_dir: 'output/articles' }).writing_style, undefined);
  assert.equal(localSchema.safeParse({ version: 1, export_dir: '', extra: true }).success, false);
});
