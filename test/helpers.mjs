import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../dist/workspace.js';
import { ApiClient } from '../dist/api.js';
import { Bridge } from '../dist/bridge.js';
import { LocalSetup } from '../dist/local-setup.js';

export async function seedAnalysis(ws, stateRoot = '.rtfm/supportpages') {
  await ws.writeJson('.rtfm/branding.json', { framework: 'test', compiled_css_path: '.rtfm/branding.css' });
  await ws.writeJson('.rtfm/project_map.json', { framework: 'test', app_type: 'web', route_index: [], dir_map: {} });
  await ws.write('.rtfm/branding.css', 'body { color: black; }');
  await ws.write('output/detect-project/summary.md', 'A tested project with article workflows.');
  await ws.write('output/detect-project/overview.txt', 'Helps people work together.');
  await new LocalSetup(ws, stateRoot).accept('output/detect-project', 'fixture', '1.0.0');
}
export async function analysedFixture(...args) {
  const f = await fixture(...args);
  await seedAnalysis(f.ws, f.bridge.stateRoot);
  return f;
}
export const article = { schema_version: 2, title: 'Invite a teammate', article_type: 'how-to', blocks: [
  { id: 'intro', type: 'prose', presentation: 'lead', content: 'Invite someone to your workspace.' },
  { id: 'invite', type: 'section', presentation: 'numbered', title: 'Send the invitation', content: 'Select **Invite**.', has_image: true },
] };
export const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlWQAAAAASUVORK5CYII=', 'base64');
export const remote = { id: '5', revision: 'a'.repeat(64), status: 'draft', editor_url: 'https://app.supportpages.io/projects/example?article=5', public_url: null };
export const capacity = { used: 0, limit: 10, can_create: true, upgrade_url: 'https://app.supportpages.io/billing', manage_articles_url: 'https://app.supportpages.io/projects' };
export const context = { repository_connection: { state: 'not_connected', connect_url: 'https://app.supportpages.io/projects/example/repository_connection', capabilities: { sections: true, suggestions: false, code_analysis: false, maintenance: false } }, article_capacity: capacity, project: { id: '1', name: 'Example' }, sections: [{id:'2', name:'Getting started', slug:'getting-started'}], supported_bundle_versions:[1], articles: [], writing_style:'Be concise.' };
/** A workspace that saves articles locally: no credential, and any network request fails the test. */
export async function localFixture(t, settings = {}) {
  const f = await fixture(t, async url => { throw Error(`Unexpected network request: ${url}`); });
  f.bridge.api = new ApiClient('https://app.supportpages.io', undefined, async url => { throw Error(`Unexpected network request: ${url}`); });
  await f.bridge.saveLocal({ version: 1, export_dir: 'output/articles', ...settings });
  await seedAnalysis(f.ws);
  return f;
}
export async function fixture(t, fetcher = async () => Response.json(context)) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'supportpages-test-'));
  t.after(async () => { await bridge.close(); await rm(root, { recursive: true, force: true }); });
  const ws = await Workspace.create(root);
  await mkdir(path.join(root, 'skills/generate-illustrated-article'), { recursive: true });
  await writeFile(path.join(root, 'skills/generate-illustrated-article/SKILL.md'), 'fixture');
  await writeFile(path.join(root, 'skills/VERSION'), '1.0.0');
  const bridge = new Bridge(ws, new ApiClient('https://app.supportpages.io', 'test-secret', (url, init) => url.endsWith('/mcp/settings') ? Promise.resolve(Response.json({preferences:{prefer_background:true,open_when_ready:false}})) : fetcher(url, init)), path.join(root, 'skills'), undefined, undefined, path.join(root, 'config'));
  return {root:ws.root, ws, bridge, async output(value = article) {
    const active = await ws.json(`${bridge.stateRoot}/active-run.json`).catch(() => undefined);
    const directory = active?.artifact_dir ?? 'output/articles/invite';
    await ws.writeJson(`${directory}/article.json`, value);
    await ws.write(`${directory}/block_invite.png`, png);
    await ws.writeJson(`${directory}/lint_report.json`, { all_passed: true, global_warnings: [] });
  }};
}
