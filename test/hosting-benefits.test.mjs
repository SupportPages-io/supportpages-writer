import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { HostingReminders, hostingBenefits, hostingReminderDue } from '../dist/hosting-benefits.js';
import { localFixture, fixture, article, png } from './helpers.mjs';
import { Bridge } from '../dist/bridge.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../dist/server.js';

const origin = 'https://app.supportpages.io';
const input = (articleId = randomUUID()) => ({ origin, articleId });
const category = item => hostingBenefits.find(benefit => benefit.id === item.id).category;

test('the first three local completions and every third afterwards carry a rotating benefit', async t => {
  const f = await fixture(t), reminders = new HostingReminders(path.join(f.root, 'config'));
  const shown = [];
  for (let count = 1; count <= 30; count++) {
    const value = input();
    const invitation = await reminders.complete(value);
    assert.equal(Boolean(invitation), hostingReminderDue(count), `completion ${count}`);
    assert.equal(await reminders.complete(value), undefined, 'the same article never counts twice');
    if (invitation) shown.push(invitation);
  }
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].filter(hostingReminderDue), [1, 2, 3, 6, 9]);
  assert.equal(shown[0].id, 'public_url');
  assert.equal(new Set(shown.slice(0, hostingBenefits.length).map(item => item.id)).size, hostingBenefits.length);
  assert.ok(shown.slice(0, hostingBenefits.length).some(item => item.id === shown[hostingBenefits.length].id), 'a new cycle reuses copy');
  for (let i = 1; i < shown.length; i++) assert.notEqual(category(shown[i]), category(shown[i - 1]));
  for (const invitation of shown) {
    assert.deepEqual(Object.keys(invitation).sort(), ['id', 'message']);
    assert.doesNotMatch(invitation.message, /https?:|supportpages publish|terminal/, 'no links or terminal commands: the agent makes the offer');
  }
});

test('disabling keeps counting, is scoped to the API origin and can be enabled again', async t => {
  const f = await fixture(t), dir = path.join(f.root, 'config');
  const a = new HostingReminders(dir), b = new HostingReminders(dir);
  assert.equal((await a.preference(origin)).enabled, true);
  await a.preference(origin, false);
  assert.deepEqual(await b.preference(origin), { enabled: false, api_origin: origin, scope: 'local_folders_on_this_device' });
  for (let i = 0; i < 6; i++) assert.equal(await b.complete(input()), undefined);
  assert.equal((await b.complete({ ...input(), origin: 'https://app.lvh.me:3443' })).id, 'public_url', 'development is separate');
  await b.preference(origin, true);
  // Six completions were counted while disabled, so the next eligible one is the ninth.
  assert.equal(await a.complete(input()), undefined);
  assert.equal(await a.complete(input()), undefined);
  assert.equal((await a.complete(input())).id, 'public_url');
});

test('independent processes serialize shared completion counts and deduplicate concurrent replays', async t => {
  const f = await fixture(t), dir = path.join(f.root, 'config'), sameArticle = randomUUID();
  const moduleUrl = new URL('../dist/hosting-benefits.js', import.meta.url).href;
  const call = value => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `import {HostingReminders} from ${JSON.stringify(moduleUrl)};
      const result = await new HostingReminders(process.argv[1]).complete(JSON.parse(process.argv[2]));
      process.stdout.write(JSON.stringify(result ?? null));`, dir, JSON.stringify(value)]);
    let stdout = '', stderr = '';
    child.stdout.on('data', value => stdout += value); child.stderr.on('data', value => stderr += value);
    child.on('error', reject); child.on('close', code => code === 0 ? resolve(JSON.parse(stdout)) : reject(Error(stderr)));
  });
  const replays = await Promise.all(Array.from({ length: 4 }, () => call(input(sameArticle))));
  assert.equal(replays.filter(Boolean).length, 1);
  const separate = await Promise.all(Array.from({ length: 5 }, () => call(input())));
  assert.equal(separate.filter(Boolean).length, 3); // completions 2, 3 and 6
});

async function savedFixture(t, configDir) {
  const f = await localFixture(t);
  const bridge = configDir ? new Bridge(f.ws, f.bridge.api, f.bridge.skillsDir, undefined, undefined, configDir) : f.bridge;
  const prepared = await bridge.prepare({ title: 'Invite', article_type: 'how-to' });
  await f.ws.writeJson(`${prepared.artifact_dir}/article.json`, article);
  await f.ws.write(`${prepared.artifact_dir}/block_invite.png`, png);
  await f.ws.writeJson(`${prepared.artifact_dir}/lint_report.json`, { all_passed: true, global_warnings: [] });
  return { ...f, bridge, prepared };
}

test('a saved local article carries the invitation once, after the path, without any network request', async t => {
  const f = await savedFixture(t);
  // The relay's early completion must leave the invitation for the parent's call.
  const early = await f.bridge.complete({ run_id: f.prepared.run_id, completed: true }, { deliver: false });
  assert.equal(early.status, 'saved');
  assert.equal(early.hosting_invitation, undefined);
  assert.match(early.instructions.join(' '), /Do not add a hosting invitation/);
  const result = await f.bridge.complete({ run_id: f.prepared.run_id, completed: true });
  assert.equal(result.status, 'saved'); assert.equal(result.local, true);
  assert.equal(result.hosting_invitation.id, 'public_url');
  const text = result.instructions.join(' ');
  assert.equal(result.show_to_user, `${result.hosting_invitation.message} If you'd like, I can host it on a SupportPages.io help centre.`);
  assert.match(result.instructions[0], /^Show show_to_user verbatim as its own paragraph, right after the saved path/);
  assert.match(text, /ask whether to sign in or create a free SupportPages.io account and call supportpages_publish/);
  assert.doesNotMatch(text, /terminal|supportpages publish\b/);
  assert.match(text, /Never start sign-in or upload without that request/);
  assert.match(text, /Do not automatically ask whether to publish or start sign-in/);
  assert.match(text, /supportpages_set_hosting_reminders with enabled=false/);
  assert.doesNotMatch(text, /Do not add a hosting invitation/);
  const run = await f.bridge.runs.read(f.prepared.run_id);
  assert.equal(run.hosting_reminder_checked, true);
  assert.deepEqual(run.hosting_invitation, result.hosting_invitation);
  // Repeating completion returns the same response, invitation included, so a
  // retry cannot lose it; the device journal still counts the article once.
  const again = await f.bridge.complete({ run_id: f.prepared.run_id, completed: true });
  assert.equal(again.markdown_path, result.markdown_path);
  assert.deepEqual(again.hosting_invitation, result.hosting_invitation);
  assert.equal(again.show_to_user, result.show_to_user);
  assert.match(again.instructions.join(' '), /supportpages_publish/);
});

test('cadence and preference follow the device across local folders', async t => {
  const owner = await fixture(t), configDir = path.join(owner.root, 'shared-config');
  const ids = [];
  for (let count = 1; count <= 6; count++) {
    const f = await savedFixture(t, configDir);
    if (count === 5) await f.bridge.hostingReminders(false);
    const result = await f.bridge.complete({ run_id: f.prepared.run_id, completed: true });
    assert.equal(Boolean(result.hosting_invitation), hostingReminderDue(count), `completion ${count}`);
    if (result.hosting_invitation) ids.push(result.hosting_invitation.id);
    if (count === 5) {
      assert.equal((await f.bridge.hostingReminders()).enabled, false);
      await f.bridge.hostingReminders(true);
    }
  }
  assert.equal(new Set(ids).size, 4); // completions 1, 2, 3 and 6, each with different copy
});

test('a broken device journal preserves the saved article and its path', async t => {
  const f = await localFixture(t);
  await f.ws.write('bad-config', 'not a directory');
  const bridge = new Bridge(f.ws, f.bridge.api, f.bridge.skillsDir, undefined, undefined, path.join(f.root, 'bad-config'));
  const prepared = await bridge.prepare({ title: 'Invite', article_type: 'how-to' });
  await f.ws.writeJson(`${prepared.artifact_dir}/article.json`, article);
  await f.ws.write(`${prepared.artifact_dir}/block_invite.png`, png);
  await f.ws.writeJson(`${prepared.artifact_dir}/lint_report.json`, { all_passed: true, global_warnings: [] });
  const result = await bridge.complete({ run_id: prepared.run_id, completed: true });
  assert.equal(result.status, 'saved');
  assert.match(result.markdown_path, /output\/articles\/invite\/index\.md$/);
  assert.equal(result.hosting_invitation, undefined);
  assert.equal((await bridge.runs.read(prepared.run_id)).phase, 'saved');
});

test('Claude and Codex receive the same optional invitation and can persist dismissal without an account', async t => {
  for (const name of ['claude-code', 'codex']) {
    const f = await savedFixture(t);
    const client = new Client({ name, version: '1.0.0' });
    const server = createServer(f.bridge);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a); await client.connect(b); t.after(() => client.close());
    const args = { run_id: f.prepared.run_id, completed: true };
    const result = await client.callTool({ name: 'supportpages_complete_article', arguments: args });
    assert.equal(result.structuredContent.result.hosting_invitation.id, 'public_url');
    assert.equal(result.structuredContent.result.local, true);
    assert.deepEqual(JSON.parse(result.content[0].text).result, result.structuredContent.result);
    const replay = await client.callTool({ name: 'supportpages_complete_article', arguments: args });
    assert.deepEqual(replay.structuredContent.result.hosting_invitation, result.structuredContent.result.hosting_invitation);
    for (const enabled of [false, true]) {
      const preference = await client.callTool({ name: 'supportpages_set_hosting_reminders', arguments: { enabled } });
      assert.equal(preference.isError, undefined);
      assert.equal(preference.structuredContent.result.enabled, enabled);
      assert.equal(preference.structuredContent.result.scope, 'local_folders_on_this_device');
      assert.equal((await f.bridge.hostingReminders()).enabled, enabled);
    }
    const repository = await client.callTool({ name: 'supportpages_set_repository_reminders', arguments: { enabled: false } });
    assert.equal(repository.isError, true, 'repository reminders still need a help centre');
    assert.equal(repository.structuredContent.error.code, 'local_workspace');
  }
});
