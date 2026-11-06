const test = require('node:test');
const assert = require('node:assert/strict');
const { startSandbox } = require('./runtime.cjs');

test('a Gmail send without complete provider receipts is uncertain, never a safe client rejection', async () => {
  const s = await startSandbox({ port: 4326 });
  const { google } = require('../node_modules/googleapis');
  const originalGmail = google.gmail;
  const auth = s.load('services/auth.service.js');
  let sends = 0, receipt = {};
  auth.resolveGoogleAccountId = async () => s.config.userId;
  auth.getGoogleAccountSummaryById = async () => ({ email: 'work@sandbox.invalid', reauthRequired: false });
  auth.refreshGoogleTokenForAccount = async () => 'sandbox-only';
  google.gmail = () => ({ users: { messages: { send: async () => { sends++; return { data: receipt }; } } } });
  const input = { toEmail: 'prospect@sandbox.invalid', subject: 'Exact approved message', body: 'Reviewed copy', expectedSenderEmail: 'work@sandbox.invalid' };
  async function send(body = input) {
    const response = await fetch(s.config.base + '/api/v1/google/gmail/send-automated-response', { method: 'POST', headers: { authorization: 'Bearer ' + s.config.token, 'content-type': 'application/json', 'x-interlink-mode': 'professional' }, body: JSON.stringify(body) });
    await response.json();
    return response.status;
  }
  try {
    assert.equal(await send({ ...input, expectedSenderEmail: 'changed@sandbox.invalid' }), 400);
    assert.equal(sends, 0);
    for (const incomplete of [{}, { id: 'accepted-message' }, { threadId: 'accepted-thread' }]) {
      receipt = incomplete;
      assert.equal(await send(), 502, 'an attempted delivery must stay uncertain so the UI cannot offer a blind resend');
    }
    receipt = { id: 'confirmed-message', threadId: 'confirmed-thread' };
    assert.equal(await send(), 201);
    assert.equal(sends, 4);
  } finally { google.gmail = originalGmail; await s.close(); }
});
