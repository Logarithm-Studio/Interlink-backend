const { PGlite } = require('@electric-sql/pglite');
const fs = require('node:fs');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');

async function createDatabase() {
  const pg = new PGlite();
  await pg.waitReady;
  await pg.exec('CREATE ROLE anon; CREATE ROLE authenticated;');
  const migrations = path.resolve(__dirname, '../src/db/migrations');
  const names = fs.readdirSync(migrations).filter(n => n.endsWith('.sql')).sort();
  for (const name of names) {
    try { await pg.exec(fs.readFileSync(path.join(migrations, name), 'utf8')); }
    catch (e) { await pg.close(); throw Error(`Sandbox migration ${name}: ${e.message}`); }
  }
  const context = new AsyncLocalStorage();
  let tail = Promise.resolve();
  async function lock() {
    let release;
    const previous = tail;
    tail = new Promise(r => { release = r; });
    await previous;
    return release;
  }
  async function raw(sql, params) {
    const r = await pg.query(sql, params);
    return { ...r, rowCount: r.affectedRows ?? r.rows.length };
  }
  async function query(sql, params) {
    if (context.getStore()) return raw(sql, params);
    const release = await lock();
    try { return await raw(sql, params); } finally { release(); }
  }
  async function connect() {
    const release = await lock();
    return { query: raw, release };
  }
  async function withTransaction(fn) {
    const client = await connect();
    try {
      await client.query('BEGIN');
      const result = await context.run(true, () => fn(client));
      await client.query('COMMIT');
      return result;
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  }
  return { query, withTransaction, getPool: () => ({ query, connect, end: () => pg.close() }),
    close: () => pg.close(), migrationCount: names.length };
}
module.exports = { createDatabase };
if (require.main === module) createDatabase().then(async d => {
  console.log(JSON.stringify({ migrations: d.migrationCount, users: (await d.query('SELECT count(*)::int AS n FROM users')).rows[0].n }));
  await d.close();
}).catch(e => { console.error(e.message); process.exitCode = 1; });
