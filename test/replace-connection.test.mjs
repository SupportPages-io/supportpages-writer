import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { context, fixture, seedAnalysis } from './helpers.mjs';
import { Session, credentialLocation } from '../dist/session.js';
import { saveTokenFile, readCredential } from '../dist/credentials.js';
import { replaceConnection } from '../dist/replace-connection.js';

const origin = 'https://app.supportpages.io';
const token = 'sp_local_' + 'a'.repeat(64);
const account = { id: '10', email: 'alice@example.com' };

async function linkedFixture(t) {
  const f = await fixture(t, async url => Response.json({ ...context, project: { id: url.includes('/projects/2/') ? '2' : '1', name: 'Example' } }));
  await seedAnalysis(f.ws);
  await f.bridge.bind('1');
  await f.ws.writeJson('.rtfm/supportpages/articles/old.json', { remote: { id: '5' } });
  await f.ws.writeJson('.rtfm/supportpages/setup/plan.json', { project_id: '1' });
  await f.ws.writeJson('.rtfm/supportpages/setup/settings.json', { agent: 'claude' });
  await f.output();
  return f;
}

test('a confirmed CLI switch archives destination state, retaining analysis, settings, outputs, other environments and the device credential', async t => {
  const f = await linkedFixture(t);
  const session = new Session({ workspace: f.root, cwd: f.root, origin, dev: false, skillsDir: path.join(f.root, 'skills'), configDir: path.join(f.root, 'config') });
  t.after(() => session.close());
  const credential = credentialLocation(origin, session.options.configDir);
  await saveTokenFile(credential.filename, origin, token, account);
  await f.ws.writeJson('.rtfm/supportpages/dev/other/binding.json', { project_id: '9' });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async url => Response.json(url.endsWith('/projects')
    ? { projects: [{ id: '2', name: 'Another' }] }
    : { ...context, project: { id: '2', name: 'Another' } });
  t.after(() => { globalThis.fetch = previousFetch; });
  const { archive } = await session.switchProject(f.ws, '1', '2');
  assert.equal((await f.bridge.binding()).project_id, '2');
  assert.deepEqual(await readCredential(credential.filename, origin), { token, account });
  assert.equal((await session.status()).project_id, '2');
  assert.equal((await f.ws.json(`${archive}/binding.json`)).project_id, '1');
  assert.equal((await f.ws.json(`${archive}/articles/old.json`)).remote.id, '5');
  assert.equal((await f.ws.json(`${archive}/setup/plan.json`)).project_id, '1');
  assert.equal(await f.ws.exists('.rtfm/supportpages/articles'), false);
  assert.equal(await f.ws.exists('.rtfm/supportpages/setup/plan.json'), false);
  assert.equal((await f.bridge.setup.analysis()).status, 'ready');
  assert.deepEqual(await f.ws.json('.rtfm/supportpages/setup/settings.json'), { agent: 'claude' });
  assert.equal(await f.ws.exists('output/articles/invite/article.json'), true);
  assert.deepEqual(await f.ws.json('.rtfm/supportpages/dev/other/binding.json'), { project_id: '9' });
  session.options.tokenFile = credential.filename;
  await assert.rejects(session.switchProject(f.ws, '2', '1'), { code: 'invalid_credentials_file' });
});

test('failed replacement restores the previous destination and all upload records', async t => {
  const f = await linkedFixture(t);
  const original = f.bridge.ws.writeJson.bind(f.bridge.ws);
  f.bridge.ws.writeJson = async (file, value) => {
    if (file.endsWith('/binding.json')) throw Error('Could not save binding');
    return original(file, value);
  };
  await assert.rejects(replaceConnection(f.bridge, '1', '2'), /Could not save binding/);
  f.bridge.ws.writeJson = original;
  assert.equal((await f.bridge.binding()).project_id, '1');
  assert.equal((await f.ws.json('.rtfm/supportpages/articles/old.json')).remote.id, '5');
  assert.equal((await f.ws.json('.rtfm/supportpages/setup/plan.json')).project_id, '1');
  assert.equal((await f.ws.list('.rtfm/supportpages/archives')).length, 0);
});

test('MCP cannot silently rebind; explicit replacement checks the expected destination and active writers', async t => {
  const f = await linkedFixture(t);
  await assert.rejects(f.bridge.bind('2'), { code: 'destination_mismatch' });
  await assert.rejects(replaceConnection(f.bridge, '9', '2'), { code: 'destination_mismatch' });
  await f.ws.writeJson('.rtfm/supportpages/setup/task.json', { skill: 'detect-project', status: 'running', started_at: new Date().toISOString() });
  await assert.rejects(replaceConnection(f.bridge, '1', '2'), { code: 'workspace_busy' });
  await f.ws.writeJson('.rtfm/supportpages/setup/task.json', { skill: 'detect-project', status: 'completed', started_at: new Date().toISOString() });
  await f.bridge.prepare({ title: 'Another article', article_type: 'how-to' });
  await assert.rejects(replaceConnection(f.bridge, '1', '2'), { code: 'generation_active' });
  assert.equal((await f.bridge.binding()).project_id, '1');
  assert.equal(await f.ws.exists('.rtfm/supportpages/archives'), false);
});

test('a replacement validates remote access before changing any local state', async t => {
  const f = await linkedFixture(t);
  f.bridge.api.request = async () => ({ ...context, project: { id: '3', name: 'Wrong' } });
  await assert.rejects(replaceConnection(f.bridge, '1', '2'), { code: 'invalid_response' });
  assert.equal((await f.bridge.binding()).project_id, '1');
  assert.equal(await f.ws.exists('.rtfm/supportpages/archives'), false);
});

test('article preparation cannot use project context fetched before a connection switch', async t => {
  const f = await linkedFixture(t);
  const originalContext = f.bridge.context.bind(f.bridge);
  f.bridge.context = async () => {
    const result = await originalContext();
    await replaceConnection(f.bridge, '1', '2');
    return result;
  };
  await assert.rejects(f.bridge.prepare({ title: 'Another article', article_type: 'how-to' }), { code: 'destination_mismatch' });
  assert.equal(await f.ws.exists('.rtfm/supportpages/active-run.json'), false);
});
