const assert = require('node:assert/strict');
const test = require('node:test');
const { startSandbox } = require('./runtime.cjs');

test('reviewed CRM prospect imports run through real auth and PostgreSQL', async t => {
  const s = await startSandbox({ port: 4318 });
  const { base, token, otherToken, userId } = s.config;
  let providerFailure = false;
  s.load('services/composio/composio.service.js').executeComposioTool = async (uid, slug, args) => {
    assert.equal(uid, userId);
    assert.equal(args.limit, 25);
    if (providerFailure) return { ok: false, message: 'Reconnect your CRM' };
    return { ok: true, data: slug.startsWith('HUBSPOT')
      ? { results: [{ id: 'crm-101', properties: { firstname: 'Ada', lastname: 'QA', email: 'ada@example.invalid', company: 'QA Company' } }] }
      : { data: { records: [{ Id: '00Q101', Name: 'Ada QA', Email: 'ada@example.invalid', Company: 'QA Company' }] } } };
  };
  async function api(url, body, status, bearer = token) {
    const r = await fetch(base + '/api/v1/marketing/prospects/' + url, { method: 'POST', headers: { authorization: 'Bearer ' + bearer, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await r.json(); assert.equal(r.status, status, JSON.stringify(data)); return data;
  }
  let preview;
  try {
    await t.test('search returns source-backed signed previews without writing contacts', async () => {
      preview = (await api('search', { provider: 'hubspot', query: 'QA Company' }, 200)).prospects[0];
      assert.equal(preview.externalId, 'crm-101'); assert.ok(preview.importToken);
      assert.equal((await s.db.query('SELECT count(*)::int AS n FROM sales_contacts')).rows[0].n, 0);
    });
    await t.test('preview cannot be tampered with or imported by another identity', async () => {
      await api('import', { importToken: preview.importToken + 'x' }, 400);
      await api('import', { importToken: preview.importToken }, 400, otherToken);
      await api('import', { importToken: preview.importToken }, 401, 'invalid');
    });
    await t.test('duplicate requests return one contact and never grant marketing consent', async () => {
      const first = await api('import', { importToken: preview.importToken }, 201);
      const again = await api('import', { importToken: preview.importToken }, 200);
      assert.equal(first.contact.id, again.contact.id);
      assert.equal(again.alreadyImported, true);
      assert.equal(first.contact.marketingOptIn, false);
      assert.equal(first.contact.marketingAttribution.crmRecordId, 'crm-101');
      assert.equal((await s.db.query('SELECT count(*)::int AS n FROM sales_contacts')).rows[0].n, 1);
    });
    await t.test('Salesforce normalization and same-email dedup preserve existing contact', async () => {
      const sf = (await api('search', { provider: 'salesforce', query: 'QA Company', title: 'Director' }, 200)).prospects[0];
      assert.equal(sf.externalId, '00Q101');
      const result = await api('import', { importToken: sf.importToken }, 200);
      assert.equal(result.contact.source, 'hubspot_research');
      assert.equal(result.contact.marketingOptIn, false);
    });
    await t.test('expired previews require another search', async () => {
      const original = Date.now;
      try { Date.now = () => original() + 16 * 60_000; await api('import', { importToken: preview.importToken }, 400); }
      finally { Date.now = original; }
    });
    await t.test('provider failure and invalid criteria do not claim an empty successful search', async () => {
      providerFailure = true;
      await api('search', { provider: 'hubspot', query: 'QA Company' }, 502);
      await api('search', { provider: 'unknown', query: 'QA Company' }, 400);
    });
    await t.test('Gmail review identifies the actual sender and rejects a changed account before delivery', async () => {
      const auth = s.load('services/auth.service.js');
      auth.resolveGoogleAccountId = async () => userId;
      auth.getGoogleAccountSummaryById = async () => ({ id: userId, email: 'work@example.invalid', reauthRequired: false });
      let sends = 0;
      s.load('services/googleApi.service.js').sendAutomatedGmailMessage = async input => {
        assert.equal(input.fromEmail, 'work@example.invalid');
        assert.equal(input.toEmail, 'ada@example.invalid');
        sends++; return { id: 'gmail-qa-1', threadId: 'thread-qa-1', labelIds: ['SENT'] };
      };
      const headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json', 'x-interlink-mode': 'professional' };
      const sender = await fetch(base + '/api/v1/google/gmail/sender', { headers });
      assert.equal(sender.status, 200); assert.equal((await sender.json()).email, 'work@example.invalid');
      const payload = { toEmail: 'ada@example.invalid', subject: 'Reviewed QA message', body: 'Exact reviewed content', expectedSenderEmail: 'old@example.invalid' };
      const send = () => fetch(base + '/api/v1/google/gmail/send-automated-response', { method: 'POST', headers, body: JSON.stringify(payload) });
      assert.equal((await send()).status, 400); assert.equal(sends, 0);
      payload.expectedSenderEmail = 'work@example.invalid';
      const response = await send(); assert.equal(response.status, 201);
      assert.equal((await response.json()).sent.id, 'gmail-qa-1'); assert.equal(sends, 1);
    });
  } finally { await s.close(); }
});
