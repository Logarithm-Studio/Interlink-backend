const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const { startSandbox } = require('./runtime.cjs');

test('Autolink accepts professional briefs and recovers safely from expired reviews and concurrent deletion', async t => {
  const s = await startSandbox({ port: 4327 });
  const uid = s.config.userId;
  const service = s.load('services/accountant/agent-task.service.js');
  const assistant = s.load('services/accountant/assistant.service.js');
  const model = s.load('services/ai/geminiClient.js');
  model.isGeminiLive = () => true;
  model.geminiGenerateContent = async () => ({ raw: 'I have read the complete brief.', model: 'fixture', latencyMs: 1 });
  async function api(route, body, status) {
    const response = await fetch(s.config.base + (route.startsWith('/api/') ? route : '/api/v1/accountant/assistant' + route), { method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer ' + s.config.token, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result;
  }
  async function prepare(goal) {
    const conversationId = crypto.randomUUID();
    await s.db.query('INSERT INTO accountant_conversations(id,user_id,title) VALUES($1,$2,$3)', [conversationId, uid, goal]);
    const taskId = await service.createAgentTask(uid, conversationId, goal);
    const action = { id: crypto.randomUUID(), name: 'create_invoice', args: { clientName: 'Recovery QA', amount: 25 }, summary: goal, needsConfirm: true };
    await service.saveTaskPlan(uid, taskId, { conversationId, action, answer: null, isLive: true });
    return { conversationId, taskId, action };
  }
  try {
    await t.test('a detailed brief is accepted intact; blank and oversized briefs explain the limit', async () => {
      const message = 'Plan the launch. ' + 'Review the actual source evidence. '.repeat(120) + 'Final checkpoint: retain all acceptance criteria.';
      const result = await api('/command', { message }, 200);
      const saved = await assistant.getConversationMessages(uid, result.conversationId);
      assert.equal(saved[0].content, message);
      await api('/command', { message: '   ' }, 400);
      const tooLong = await api('/command', { message: 'x'.repeat(12001) }, 400);
      assert.match(tooLong.error, /12000|12,000/);
      await api('/api/v1/personal-assistant/command', { message }, 200);
      await api('/api/v1/personal-assistant/command', { message: '  ' }, 400);
    });
    await t.test('expired approval becomes a reviewable recovery state without executing or erasing receipts', async () => {
      const { taskId, action } = await prepare('Recover an expired review');
      await s.db.query("UPDATE autolink_action_proposals SET expires_at=now()-interval '1 minute' WHERE id=$1", [action.id]);
      const restored = (await api('/tasks/' + taskId, undefined, 200)).task;
      assert.equal(restored.status, 'ready');
      assert.equal(restored.action, null);
      assert.equal(restored.steps[0].status, 'cancelled');
      await api('/tasks/' + taskId + '/actions/' + action.id + '/execute', {}, 409);
      assert.equal((await service.claimTaskContinuation(uid, taskId)).id, taskId);
      await service.releaseTaskContinuation(uid, taskId);
    });
    await t.test('deletion cannot erase an in-flight action and its durable receipt', async () => {
      const { conversationId, taskId, action } = await prepare('Protect an active action');
      let release, entered;
      const started = new Promise(resolve => { entered = resolve; });
      const gate = new Promise(resolve => { release = resolve; });
      const running = service.executeTaskProposal(uid, taskId, action.id, async () => { entered(); await gate; return { ok: true, message: 'Confirmed fixture write.' }; });
      await started;
      try { await assert.rejects(assistant.deleteConversation(uid, conversationId), /running|progress|finish/i); }
      finally { release(); }
      const result = await running;
      assert.equal(result.task.steps[0].status, 'succeeded');
      await assistant.deleteConversation(uid, conversationId);
      assert.equal(await service.getAgentTask(uid, taskId), null);
    });
    await t.test('invalid task IDs are caller errors, not server crashes', async () => {
      await api('/tasks/not-a-uuid', undefined, 400);
      await api('/tasks/not-a-uuid/continue', {}, 400);
    });
  } finally { await s.close(); }
});
