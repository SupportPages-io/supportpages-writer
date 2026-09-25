import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runCli } from '../scripts/lib/cli.mjs';
import { scenarioFixture, scenarios } from './scenario-helpers.mjs';

async function terminal(t, scenario) {
  const f = await scenarioFixture(t, scenario), lines = [], opened = [];
  const skills = path.join(f.root, 'skills'), configDir = path.join(f.root, 'config');
  await f.ws.writeJson('config/installations/supportpages.json', { clients: ['codex'] });
  await f.ws.writeJson('config/installations/supportpages.mcp.json', { mcpServers: { supportpages: { args: ['--skills-dir', skills] } } });
  const session = { options: { skillsDir: skills, configDir }, bridge: async () => f.bridge, workspace: async () => f.ws,
    status: () => f.bridge.status(), login: () => assert.fail('Commands must not start sign-in'), close() {} };
  const deps = { installRoot: path.resolve('.'), home: path.join(f.root, 'home'),
    env: { SUPPORTPAGES_API_URL: undefined, SUPPORTPAGES_DEV: undefined }, sessionFactory: () => session,
    run: async command => {
      if (scenario === 'connected' && ['codex', 'claude'].includes(command)) assert.fail('Hosted commands must not launch or require a coding agent');
      return { code: command === 'codex' ? 0 : 1 };
    },
    openAgent: async input => { opened.push(input); return true; },
    runAgent: async () => assert.fail('Analysis must not be rerun'),
    ui: { line: value => lines.push(value), ok: value => lines.push(value), ask: async () => 'Invite',
      choose: async (_, choices) => choices[0].value, confirm: async () => true } };
  return { ...f, lines, opened, run: command => runCli({ command, workspace: f.root, 'config-dir': configDir, 'skills-dir': skills }, deps) };
}
for (const scenario of scenarios) {
  test(`${scenario}: CLI write chooses hosted submission or local authoring`, async t => {
    const f = await terminal(t, scenario);
    const response = await f.run('write');
    if (scenario === 'connected') {
      assert.equal(response.status, 'queued');
      assert.equal(response.action, 'create_article');
      assert.equal(f.opened.length, 0);
      assert.ok(f.lines.includes('Operation 6: queued'));
      assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
    } else {
      assert.equal(f.opened.length, 1);
      assert.equal(f.calls.filter(c => c.method !== 'GET').length, 0);
      assert.match(f.opened[0].prompt, /supportpages_prepare_article/);
    }
  });
  for (const [command, action] of [['sections', 'suggest_sections'], ['recommend', 'recommend_articles']]) {
    test(`${scenario}: CLI ${command} respects repository and account access`, async t => {
      const f = await terminal(t, scenario);
      if (scenario === 'connected') {
        const response = await f.run(command);
        assert.equal(response.action, action);
        assert.equal(response.status, 'queued');
        assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
        assert.ok(f.lines.includes('Operation 6: queued'));
      } else {
        await assert.rejects(f.run(command), { code: scenario === 'anonymous' ? 'authentication_required' : 'repository_required' });
        assert.equal(f.calls.filter(c => c.method !== 'GET').length, 0);
      }
      assert.equal(f.opened.length, 0);
      assert.equal(await f.ws.exists(`${f.bridge.stateRoot}/active-run.json`), false);
    });
  }
}
for (const code of ['repository_suspended', 'repository_disconnected', 'analysing', 'permission_required', 'plan_limit', 'server_update_required']) {
  test(`CLI write blocked by ${code} never launches a local agent`, async t => {
    const f = await terminal(t, 'connected');
    const decision = f.metadata.repository_connection.writer.actions.create_article;
    decision.allowed = false;
    decision.next_step = { code, message: 'Complete the prerequisite.', requested_action: 'create_article' };
    await assert.rejects(f.run('write'), { code });
    assert.equal(f.opened.length, 0);
    assert.equal(f.calls.filter(c => c.method !== 'GET').length, 0);
    assert.equal(await f.ws.exists(`${f.bridge.stateRoot}/active-run.json`), false);
  });
}
