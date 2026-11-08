const test = require('node:test');
const assert = require('node:assert/strict');
const { startSandbox } = require('./runtime.cjs');

test('Professional task intake, reviewed continuation and durable duplicate protection', async t => {
  const s = await startSandbox({ port: 4324 });
  const uid = s.config.userId;
  const fixtureTask = async goal => {
    const conversationId = require('node:crypto').randomUUID();
    await s.db.query('INSERT INTO accountant_conversations(id,user_id,title) VALUES($1,$2,$3)', [conversationId, uid, goal]);
    return s.load('services/accountant/agent-task.service.js').createAgentTask(uid, conversationId, goal);
  };
  await s.db.query("UPDATE profession_profiles SET persona='finance' WHERE user_id=$1 AND mode='professional'", [uid]);
  const model = s.load('services/ai/geminiClient.js');
  model.isGeminiLive = () => true;
  let modelStep = 0;
  model.geminiGenerateContent = async options => {
    modelStep++;
    if (modelStep === 2) {
      assert.ok(JSON.stringify(options.contents).includes('First client'), 'Continuation must retain the original request and actual outcome.');
      assert.ok(JSON.stringify(options.contents).includes('succeeded'));
      assert.ok(options.contents.some(turn => turn.parts.some(part => part.text?.includes('"amount":75'))), 'Continuation must retain the exact applied arguments, not only the action summary.');
    }
    const functionCall = modelStep <= 2 ? { name: 'create_invoice', args: { clientName: modelStep === 1 ? 'First client' : 'Second client', amount: 75 } } : { name: 'complete_professional_task', args: { answer: 'Both requested invoices were saved.' } };
    return { raw: functionCall ? 'I will save each requested invoice separately for your review.' : 'Both requested invoices were saved.', functionCall, model: 'fixture', latencyMs: 1 };
  };
  const api = async (route, body, expected = 200, token = s.config.token) => {
    const response = await fetch(s.config.base + '/api/v1/accountant/assistant' + route, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const json = await response.json();
    assert.equal(response.status, expected, JSON.stringify(json));
    return json;
  };
  try {
    const plan = await api('/command', { message: 'Create an invoice for First client and then another for Second client, $75 each.' });
    const taskId = plan.task.id;
    const actionId = plan.action.id;
    const execute = '/tasks/' + taskId + '/actions/' + actionId + '/execute';
    await t.test('intake persists a reviewable task without performing any write', async () => {
      assert.equal(plan.task.status, 'review');
      assert.equal((await s.db.query('SELECT id FROM invoices WHERE user_id=$1', [uid])).rows.length, 0);
      const restored = await api('/tasks/latest');
      assert.equal(restored.task.action.id, actionId);
      assert.equal(restored.task.goal, 'Create an invoice for First client and then another for Second client, $75 each.');
    });
    await t.test('another user cannot read, confirm, or continue the task', async () => {
      await api('/tasks/' + taskId, undefined, 404, s.config.otherToken);
      await api(execute, {}, 404, s.config.otherToken);
      await api('/tasks/' + taskId + '/continue', {}, 404, s.config.otherToken);
    });
    await t.test('concurrent confirmations use the saved arguments and create exactly one record', async () => {
      const results = await Promise.all([1, 2].map(async () => {
        const response = await fetch(s.config.base + '/api/v1/accountant/assistant' + execute, { method: 'POST', headers: { Authorization: 'Bearer ' + s.config.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'send_gmail', args: { amount: 999999 } }) });
        assert.ok([200, 409].includes(response.status));
        return response.json();
      }));
      assert.ok(results.some(r => r.ok));
      const rows = (await s.db.query('SELECT client_name,amount_cents FROM invoices WHERE user_id=$1', [uid])).rows;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].client_name, 'First client');
      assert.equal(Number(rows[0].amount_cents), 7500);
      assert.equal((await api(execute, {})).ok, true);
      assert.equal((await s.db.query('SELECT id FROM invoices WHERE user_id=$1', [uid])).rows.length, 1);
    });
    let second;
    await t.test('continuation proposes the next action and does not repeat the completed one', async () => {
      second = await api('/tasks/' + taskId + '/continue', {});
      assert.equal(second.task.id, taskId);
      assert.equal(second.action.args.clientName, 'Second client');
      assert.deepEqual(second.task.steps.map(s => s.status), ['succeeded', 'pending']);
      await api('/tasks/' + taskId + '/continue', {}, 409);
    });
    await t.test('pause prevents a delayed confirmation from executing', async () => {
      await api('/tasks/' + taskId + '/pause', {});
      await api('/tasks/' + taskId + '/actions/' + second.action.id + '/execute', {}, 409);
      assert.equal((await s.db.query('SELECT id FROM invoices WHERE user_id=$1', [uid])).rows.length, 1);
    });
    await t.test('expired approval cannot perform a write', async () => {
      const service = s.load('services/accountant/agent-task.service.js');
      const id = await fixtureTask('Expired approval fixture');
      const action = { ...second.action, id: require('node:crypto').randomUUID() };
      await service.saveTaskPlan(uid, id, { action, answer: null, conversationId: plan.conversationId, isLive: true });
      await s.db.query("UPDATE autolink_action_proposals SET expires_at=now()-interval '1 minute' WHERE id=$1", [action.id]);
      await api('/tasks/' + id + '/actions/' + action.id + '/execute', {}, 409);
    });
    await t.test('successful second action finishes with both durable receipts', async () => {
      await api('/tasks/' + taskId + '/resume', {});
      assert.equal((await api('/tasks/' + taskId + '/actions/' + second.action.id + '/execute', {})).ok, true);
      const done = await api('/tasks/' + taskId + '/continue', {});
      assert.equal(done.action, null);
      assert.equal(done.task.status, 'answered');
      assert.equal(done.task.steps.filter(s => s.status === 'succeeded').length, 2);
      assert.equal((await s.db.query('SELECT id FROM invoices WHERE user_id=$1', [uid])).rows.length, 2);
    });
    await t.test('new task tables deny direct Data API roles', async () => {
      for (const table of ['autolink_tasks', 'autolink_action_proposals']) {
        const row = (await s.db.query('SELECT relrowsecurity FROM pg_class WHERE relname=$1', [table])).rows[0];
        assert.equal(row.relrowsecurity, true);
        assert.equal((await s.db.query("SELECT has_table_privilege('authenticated',$1,'SELECT') AS allowed", [table])).rows[0].allowed, false);
      }
    });
    await t.test('task read-back retains approved content and excludes other users', async () => {
      const service = s.load('services/accountant/agent-task.service.js');
      const own = await service.readProfessionalTasks(uid, { taskId });
      assert.equal(own.data.tasks.length, 1);
      assert.equal(own.data.tasks[0].receipts[0].args.amount, 75);
      assert.equal((await service.readProfessionalTasks(s.config.otherUserId, { taskId })).data.tasks.length, 0);
    });
    await t.test('attachment continuation requires the original bytes and preserves completed steps', async () => {
      const crypto = require('node:crypto');
      const service = s.load('services/accountant/agent-task.service.js');
      const data = Buffer.from('Original launch checklist').toString('base64');
      const digest = crypto.createHash('sha256').update(Buffer.from(data, 'base64')).digest('hex');
      const id = await fixtureTask('Use the attached file to prepare the next task.');
      const action = { id: crypto.randomUUID(), name: 'create_invoice', args: { clientName: 'File test', amount: 12 }, summary: 'Prepare file test', needsConfirm: true };
      await service.saveTaskPlan(uid, id, { action, answer: null, conversationId: plan.conversationId, isLive: true }, { sourceAttachmentDigest: digest });
      await service.executeTaskProposal(uid, id, action.id, async () => ({ ok: true, message: 'First step confirmed.' }));
      await api('/tasks/' + id + '/continue', {}, 409);
      await api('/tasks/' + id + '/continue', { attachmentBase64: Buffer.from('Wrong file').toString('base64'), attachmentMimeType: 'text/plain' }, 409);
      assert.equal((await api('/tasks/' + id)).task.status, 'ready');
      const resumed = await api('/tasks/' + id + '/continue', { attachmentBase64: data, attachmentMimeType: 'text/plain' });
      assert.equal(resumed.task.steps.filter(step => step.status === 'succeeded').length, 1);
    });
    await t.test('an unconfirmed action blocks continuation and cannot be run again', async () => {
      const crypto = require('node:crypto');
      const service = s.load('services/accountant/agent-task.service.js');
      const id = await fixtureTask('Prepare one controlled action.');
      const action = { id: crypto.randomUUID(), name: 'create_invoice', args: {}, summary: 'Controlled uncertain action', needsConfirm: true };
      await service.saveTaskPlan(uid, id, { action, answer: null, conversationId: plan.conversationId, isLive: true });
      let calls = 0;
      const execute = async () => { calls++; return { ok: false, message: 'Provider result is uncertain.' }; };
      const result = await service.executeTaskProposal(uid, id, action.id, execute);
      assert.equal(result.task.status, 'blocked');
      await assert.rejects(() => service.claimTaskContinuation(uid, id));
      assert.equal((await service.executeTaskProposal(uid, id, action.id, execute)).ok, false);
      assert.equal(calls, 1);
    });
    await t.test('receipt persistence failure after a write leaves the action locked against retries', async () => {
      const crypto = require('node:crypto');
      const service = s.load('services/accountant/agent-task.service.js');
      const db = s.load('config/db.js');
      const original = db.withTransaction;
      const id = await fixtureTask('Exercise durable receipt failure.');
      const action = { id: crypto.randomUUID(), name: 'create_invoice', args: {}, summary: 'Receipt failure', needsConfirm: true };
      await service.saveTaskPlan(uid, id, { action, answer: null, conversationId: plan.conversationId, isLive: true });
      let writes = 0;
      const execute = async () => { writes++; return { ok: true, message: 'Provider write completed.' }; };
      let transactions = 0;
      db.withTransaction = async work => { if (++transactions === 2) throw new Error('Simulated receipt persistence outage'); return original(work); };
      try { await assert.rejects(() => service.executeTaskProposal(uid, id, action.id, execute)); }
      finally { db.withTransaction = original; }
      await assert.rejects(() => service.executeTaskProposal(uid, id, action.id, execute), /has not been run again/);
      assert.equal(writes, 1);
    });
  } finally { await s.close(); }
});
