const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startSandbox } = require('./runtime.cjs');

test('Autolink execution history and saved Marketing reads use owned real records', async t => {
  const s = await startSandbox({ port: 4321 });
  const a = { userId: s.config.userId, token: s.config.token };
  const b = { userId: s.config.otherUserId, token: s.config.otherToken };
  await s.db.query("UPDATE profession_profiles SET persona='finance' WHERE user_id=$1 AND mode='professional'", [a.userId]);
  const api = async (route, body, token = a.token, expected = 200) => {
    const response = await fetch(s.config.base + route, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json();
    assert.equal(response.status, expected, JSON.stringify(result));
    return result;
  };
  const conversationId = crypto.randomUUID();
  await s.db.query('INSERT INTO accountant_conversations(id,user_id,title) VALUES($1,$2,$3)', [conversationId, a.userId, 'QA execution memory']);
  const route = '/api/v1/accountant/assistant/execute';
  try {
    await t.test('confirmed execution records an actual success in the owned conversation', async () => {
      const result = await api(route, { name: 'create_invoice', args: { clientName: 'QA memory invoice', amount: 25 }, conversationId });
      assert.equal(result.ok, true, result.message);
      const messages = await s.db.query('SELECT content FROM accountant_chat_messages WHERE conversation_id=$1 AND user_id=$2', [conversationId, a.userId]);
      assert.equal(messages.rows.length, 1);
      assert.match(messages.rows[0].content, /Action outcome for create_invoice/);
      assert.match(messages.rows[0].content, /"ok":true/);
      assert.ok(messages.rows[0].content.includes(result.message));
    });
    await t.test('another user cannot execute against this conversation or create a side effect', async () => {
      await api(route, { name: 'create_invoice', args: { clientName: 'Must never be created', amount: 25 }, conversationId }, b.token, 404);
      const records = await s.db.query('SELECT id FROM invoices WHERE client_name=$1', ['Must never be created']);
      assert.equal(records.rows.length, 0);
    });
    await t.test('a failed action is recorded as failed instead of a completed proposal', async () => {
      const result = await api(route, { name: 'unsupported_qa_action', args: {}, conversationId });
      assert.equal(result.ok, false);
      const messages = await s.db.query('SELECT content FROM accountant_chat_messages WHERE conversation_id=$1 AND content LIKE $2', [conversationId, '%unsupported_qa_action%']);
      assert.equal(messages.rows.length, 1);
      assert.match(messages.rows[0].content, /"ok":false/);
    });
    await t.test('history failure cannot turn a completed action into a retryable request failure', async () => {
      const db = s.load('config/db.js');
      const original = db.query;
      db.query = async (sql, args) => { if (/INSERT INTO accountant_chat_messages/i.test(sql)) throw new Error('Simulated history outage'); return original(sql, args); };
      try {
        const result = await api(route, { name: 'create_invoice', args: { clientName: 'QA history outage', amount: 25 }, conversationId });
        assert.equal(result.ok, true, result.message);
      } finally { db.query = original; }
      const records = await s.db.query('SELECT id FROM invoices WHERE client_name=$1', ['QA history outage']);
      assert.equal(records.rows.length, 1);
    });
    await t.test('campaign lookup returns real IDs and status while excluding another user', async () => {
      const own = await api('/api/v1/sales/campaigns', { topic: 'Owned Autolink QA', objective: 'Get ten leads', successMetric: '10 qualified leads', channels: ['email'] });
      const other = await api('/api/v1/sales/campaigns', { topic: 'Private other campaign' }, b.token);
      const read = s.load('services/professional/marketing/assistant-read.service.js').readMarketingCampaigns;
      const found = await read(a.userId, { query: 'Owned Autolink QA' });
      assert.equal(found.data.campaigns.length, 1);
      assert.equal(found.data.campaigns[0].id, own.campaign.id);
      assert.equal(found.data.campaigns[0].status, 'draft');
      assert.equal(own.campaign.subject, 'Owned Autolink QA', 'Unavailable AI must retain the actual campaign topic.');
      assert.equal(own.campaign.body, '', 'Unavailable AI must not insert an unrelated follow-up email as campaign copy.');
      assert.equal(found.data.campaigns[0].successMetric, '10 qualified leads');
      assert.equal((await read(a.userId, { campaignId: other.campaign.id })).data.campaigns.length, 0);
      await assert.rejects(() => read(a.userId, { campaignId: 'not-a-uuid' }));
    });
  } finally { await s.close(); }
});
