const test = require('node:test');
const assert = require('node:assert/strict');
const { startSandbox } = require('./runtime.cjs');

test('Notion search reports provider errors instead of claiming there are no shared pages', async () => {
  const s = await startSandbox({ port: 4323 });
  const originalFetch = global.fetch;
  try {
    await s.connectNative(s.config.userId, 'notion');
    global.fetch = async (input, init) => String(input).startsWith('https://api.notion.com/v1/search')
      ? new Response(JSON.stringify({ message: 'private provider details' }), { status: 503 })
      : originalFetch(input, init);
    await assert.rejects(s.load('services/notion/notion.service.js').searchPages(s.config.userId, 'Shared'), /Couldn.t search Notion pages/);
    global.fetch = async () => new Response(JSON.stringify({ results: [] }));
    assert.deepEqual(await s.load('services/notion/notion.service.js').searchPages(s.config.userId, 'Shared'), []);
  } finally { global.fetch = originalFetch; await s.close(); }
});

test('a backend key/configuration fault never destroys saved Google credentials', async () => {
  const s = await startSandbox({ port: 4323 });
  const auth = s.load('services/auth.service.js');
  const crypto = s.load('security/crypto.js');
  const decrypt = crypto.decrypt;
  try {
    // Use the actual encrypted storage and read path, rather than the provider adapter.
    await auth.upsertGoogleAccountOnConnect(s.config.userId, {
      tokens: { accessToken: 'fixture-access', refreshToken: 'fixture-refresh', expiresAt: new Date(Date.now() + 3600000) },
      email: 'retain@sandbox.invalid', role: 'professional',
    });
    const row = (await s.db.query('SELECT id,refresh_token FROM google_accounts WHERE user_id=$1', [s.config.userId])).rows[0];
    crypto.decrypt = () => { throw new Error('Key temporarily unavailable after deployment'); };
    await assert.rejects(() => auth.getTokensByAccountId(row.id));
    const after = (await s.db.query('SELECT refresh_token,reauth_required FROM google_accounts WHERE id=$1', [row.id])).rows[0];
    assert.equal(after.refresh_token, row.refresh_token, 'A deploy/configuration fault must preserve the refresh credential.');
    assert.equal(after.reauth_required, false, 'A server configuration failure is not user revocation.');
    crypto.decrypt = decrypt;
    assert.equal((await auth.getTokensByAccountId(row.id)).refreshToken, 'fixture-refresh');
  } finally { crypto.decrypt = decrypt; await s.close(); }
});

test('parallel Google refreshes rotate once and transient authorization failures retain the connection', async () => {
  const s = await startSandbox({ port: 4323 });
  const auth = s.load('services/auth.service.js');
  const { google } = require('../node_modules/googleapis');
  const prototype = google.auth.OAuth2.prototype;
  const original = prototype.refreshAccessToken;
  try {
    const { accountId } = await auth.upsertGoogleAccountOnConnect(s.config.userId, { email: 'refresh@sandbox.invalid', tokens: { accessToken: 'old', refreshToken: 'original-refresh', expiresAt: new Date(0) } });
    let calls = 0;
    prototype.refreshAccessToken = async () => { calls++; await new Promise(resolve => setTimeout(resolve, 10)); return { credentials: { access_token: 'new-access', refresh_token: 'rotated-refresh', expiry_date: Date.now() + 3600000 } }; };
    const tokens = await Promise.all(Array.from({ length: 8 }, () => auth.refreshGoogleTokenForAccount(accountId)));
    assert.ok(tokens.every(token => token === 'new-access'));
    assert.equal(calls, 1);
    assert.equal((await auth.getTokensByAccountId(accountId)).refreshToken, 'rotated-refresh');
    await auth.storeTokensForAccount(accountId, { accessToken: 'old', refreshToken: 'rotated-refresh', expiresAt: new Date(0) });
    prototype.refreshAccessToken = async () => { throw Object.assign(new Error('Provider temporarily denied this client request'), { status: 403 }); };
    await assert.rejects(() => auth.refreshGoogleTokenForAccount(accountId));
    assert.equal((await auth.getTokensByAccountId(accountId)).refreshToken, 'rotated-refresh');
    prototype.refreshAccessToken = async () => { throw new Error('invalid_grant'); };
    await assert.rejects(() => auth.refreshGoogleTokenForAccount(accountId), /Reauth required/);
    assert.equal((await s.db.query('SELECT reauth_required FROM google_accounts WHERE id=$1', [accountId])).rows[0].reauth_required, true);
  } finally { prototype.refreshAccessToken = original; await s.close(); }
});
