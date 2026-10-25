const crypto = require('node:crypto');
function createIdentity() {
  const secret = crypto.randomBytes(32), users = new Map(), access = new Map(), refresh = new Map();
  function create(email) {
    const u = { id: crypto.randomUUID(), email, aud: 'authenticated', role: 'authenticated',
      email_confirmed_at: new Date().toISOString(), created_at: new Date().toISOString(),
      app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: { fullName: 'Sandbox QA' },
      identities: [] };
    const password = 'Sandbox-' + crypto.randomBytes(10).toString('hex');
    users.set(u.id, { user: u, password });
    return { user: u, password };
  }
  function session(user) {
    const now = Math.floor(Date.now()/1000);
    const encode = x => Buffer.from(JSON.stringify(x)).toString('base64url');
    const body = encode({ alg: 'HS256', typ: 'JWT' })+'.'+encode({ sub: user.id, aud: 'authenticated', role: 'authenticated', email: user.email, iat: now, exp: now+3600, session_id: crypto.randomUUID() });
    const token = body+'.'+crypto.createHmac('sha256',secret).update(body).digest('base64url');
    const rt = crypto.randomBytes(32).toString('hex');
    access.set(token, { id: user.id, expires: now+3600 }); refresh.set(rt, user.id);
    return { access_token: token, refresh_token: rt, expires_in: 3600, expires_at: now+3600, token_type: 'bearer', user };
  }
  function resolve(token) {
    const s = access.get(token);
    return s && s.expires > Date.now()/1000 ? users.get(s.id)?.user : null;
  }
  function mount(app) {
    app.post('/auth/v1/token', (req,res) => {
      const entry = req.query.grant_type === 'refresh_token'
        ? users.get(refresh.get(req.body.refresh_token))
        : [...users.values()].find(e => e.user.email === req.body.email && e.password === req.body.password);
      if (!entry) return res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid sandbox credentials' });
      if (req.body.refresh_token) refresh.delete(req.body.refresh_token);
      res.json(session(entry.user));
    });
    app.get('/auth/v1/user', (req,res) => {
      const user = resolve((req.headers.authorization||'').replace(/^Bearer /,''));
      return user ? res.json(user) : res.status(401).json({ message: 'Invalid sandbox session' });
    });
    app.post('/auth/v1/logout', (req,res) => { access.delete((req.headers.authorization||'').replace(/^Bearer /,'')); res.status(204).end(); });
    app.get('/auth/v1/admin/users/:id', (req,res) => res.json({ user: users.get(req.params.id)?.user }));
  }
  return { create, session, resolve, mount, clear: () => { users.clear(); access.clear(); refresh.clear(); }, get size() { return users.size; } };
}
module.exports = { createIdentity };
