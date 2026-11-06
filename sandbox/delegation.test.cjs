const test = require('node:test');
const assert = require('node:assert/strict');
const { startSandbox } = require('./runtime.cjs');

test('native delegation checks assignees and provider read-back through the real executors', async t => {
  const s = await startSandbox({ port: 4325 });
  const originalFetch = global.fetch;
  const tokens = s.load('services/integrations/tokenStore.js');
  const originalIntegration = tokens.getIntegration;
  tokens.getIntegration = async () => ({ status: 'active', accessToken: 'fixture', tokenExpiresAt: new Date(Date.now() + 3600000), metadata: { cloudId: 'fixture-cloud' } });
  const writes = [];
  let jiraAccount = null;
  global.fetch = async (input, init) => {
    const url = new URL(String(input));
    const response = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
    if (url.hostname === 'api.github.com') {
      if (init?.method === 'POST') { writes.push({ provider: 'github', body: JSON.parse(init.body) }); return response({ number: 7, assignees: [{ login: 'sam' }], html_url: 'https://github.com/fixture/project/issues/7' }); }
      if (url.pathname.endsWith('/assignees/sam')) return new Response(null, { status: 204 });
      if (url.pathname.endsWith('/assignees/unknown')) return new Response(null, { status: 404 });
      return response([{ login: 'sam' }]);
    }
    if (url.hostname === 'api.atlassian.com') {
      if (url.pathname.endsWith('/user/assignable/search')) return response([{ accountId: 'person-sam', displayName: 'Sam', active: true }]);
      if (init?.method === 'PUT') { jiraAccount = JSON.parse(init.body).accountId; writes.push({ provider: 'jira' }); return new Response(null, { status: 204 }); }
      return response({ fields: { assignee: { accountId: jiraAccount, displayName: 'Sam' } } });
    }
    return originalFetch(input, init);
  };
  const agent = s.load('services/personal-assistant/personal-assistant.service.js');
  try {
    await t.test('discovery returns actual provider IDs and is read-only', async () => {
      const gh = await agent.executeAction(s.config.userId, 'list_github_assignees', { repo: 'fixture/project' });
      const jira = await agent.executeAction(s.config.userId, 'find_jira_assignees', { projectKey: 'QA', query: 'Sam' });
      assert.equal(gh.data[0].login, 'sam');
      assert.equal(jira.data[0].accountId, 'person-sam');
      assert.equal(writes.length, 0);
      assert.equal(agent.isReadOnlyAction('assign_github_issue'), false);
      assert.equal(agent.isReadOnlyAction('assign_jira_issue'), false);
    });
    await t.test('unassignable GitHub users fail without a provider write', async () => {
      const result = await agent.executeAction(s.config.userId, 'assign_github_issue', { repo: 'fixture/project', issueNumber: 7, assignee: 'unknown' });
      assert.equal(result.ok, false);
      assert.equal(writes.length, 0);
    });
    await t.test('GitHub and Jira assignment success requires returned assignees', async () => {
      const gh = await agent.executeAction(s.config.userId, 'assign_github_issue', { repo: 'fixture/project', issueNumber: 7, assignee: 'sam' });
      const jira = await agent.executeAction(s.config.userId, 'assign_jira_issue', { issueKey: 'QA-7', accountId: 'person-sam' });
      assert.equal(gh.ok, true, gh.message);
      assert.equal(jira.ok, true, jira.message);
      assert.equal(jira.data.accountId, 'person-sam');
      assert.equal(writes.length, 2);
    });
  } finally { global.fetch = originalFetch; tokens.getIntegration = originalIntegration; await s.close(); }
});
