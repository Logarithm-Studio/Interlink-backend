// Read-only: no migrations, schedules, account connections or provider writes.
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { Client } = require('pg');

const root = path.resolve(__dirname, '..');
const online = process.argv.includes('--online');
const unknown = process.argv.slice(2).filter(arg => arg !== '--online');
if (unknown.length) {
  console.error('Use npm run marketing:readiness [-- --online].');
  process.exit(2);
}
const readEnv = file => fs.existsSync(file) ? dotenv.parse(fs.readFileSync(file)) : {};
const env = { ...readEnv(path.join(root, '.env')), ...process.env };
const appEnv = readEnv(path.join(root, '../Interlink-app/.env'));
let failures = 0;
function report(ok, name, detail) {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'BLOCKED'} ${name}: ${detail}`);
}
function origin(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
    return url.origin;
  } catch { return null; }
}

async function database() {
  if (!env.DATABASE_URL) return;
  const db = new Client({
    connectionString: env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, // Match the existing backend connection.
    connectionTimeoutMillis: 10000,
    statement_timeout: 10000,
    query_timeout: 12000,
  });
  // Do not print provider errors: connection strings and credentials may be embedded.
  db.on('error', () => {});
  try {
    await db.connect();
    await db.query('BEGIN READ ONLY');
    const tracking = await db.query("SELECT to_regclass('public._migrations') IS NOT NULL AS present");
    if (!tracking.rows[0].present) {
      report(false, 'Database migrations', 'migration tracking table is missing');
      return;
    }
    const applied = new Set((await db.query('SELECT name FROM public._migrations')).rows.map(row => row.name));
    const required = fs.readdirSync(path.join(root, 'src/db/migrations')).filter(name => name.endsWith('.sql')).sort();
    const missing = required.filter(name => !applied.has(name));
    report(!missing.length, 'Database migrations', missing.length ? `${missing.length} pending: ${missing.join(', ')}` : `${required.length} local migrations recorded`);
    const tables = ['sales_marketing_email_sequences', 'sales_marketing_agreements', 'sales_marketing_research_plans', 'sales_marketing_research_exports'];
    const result = await db.query(
      `SELECT c.relname, c.relrowsecurity,
         has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE') AS anon_access,
         has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE') AS authenticated_access
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relname=ANY($1::text[])`, [tables]);
    const protectedTables = result.rows.filter(row => row.relrowsecurity && !row.anon_access && !row.authenticated_access);
    report(protectedTables.length === tables.length, 'Outreach table protection', `${protectedTables.length}/${tables.length} tables exist with RLS and no direct anon/authenticated CRUD grants`);
  } catch {
    report(false, 'Database inspection', 'could not finish read-only checks; inspect connectivity and schema privately');
  } finally {
    try { await db.query('ROLLBACK'); } catch {}
    await db.end().catch(() => {});
  }
}

async function schedules(apiOrigin) {
  if (!env.QSTASH_TOKEN || !apiOrigin) return;
  try {
    const response = await fetch('https://qstash.upstash.io/v2/schedules', {
      headers: { Authorization: `Bearer ${env.QSTASH_TOKEN}` },
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) throw new Error('Schedule list failed');
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error('Invalid schedule list');
    for (const [name, route, cron] of [
      ['Hourly', '/api/v1/workers/marketing-todoist-dispatch', '0 * * * *'],
      ['Daily', '/api/v1/workers/marketing-analytics-dispatch', '15 2 * * *'],
    ]) {
      const matches = rows.filter(row => row.destination === new URL(route, apiOrigin).href);
      const active = matches.filter(row => row.isPaused === false && row.method === 'POST' && row.cron === cron);
      report(matches.length === 1 && active.length === 1, `${name} QStash schedule`, `${matches.length} matching destination(s), ${active.length} active with expected method/cron`);
    }
  } catch {
    report(false, 'QStash inspection', 'could not read schedules; check token and connectivity privately');
  }
}

async function health(apiOrigin) {
  if (!apiOrigin) return;
  try {
    const response = await fetch(new URL('/health', apiOrigin), { signal: AbortSignal.timeout(12000) });
    const body = await response.json();
    report(response.ok && body.status === 'ok', 'API health', response.ok && body.status === 'ok' ? 'reachable; health alone does not verify this release is deployed' : 'unexpected status');
  } catch {
    report(false, 'API health', 'health endpoint did not return the expected JSON');
  }
}

async function main() {
  console.log(`Marketing readiness (${online ? 'read-only remote checks' : 'local configuration only'})`);
  for (const name of ['DATABASE_URL', 'QSTASH_TOKEN', 'QSTASH_CURRENT_SIGNING_KEY', 'QSTASH_NEXT_SIGNING_KEY', 'DOCUSIGN_CLIENT_ID', 'DOCUSIGN_CLIENT_SECRET']) {
    report(Boolean(env[name]?.trim()), name, env[name]?.trim() ? 'configured (value hidden)' : 'not configured');
  }
  const authHost = env.DOCUSIGN_AUTH_URL || 'https://account-d.docusign.com';
  report(['https://account-d.docusign.com', 'https://account.docusign.com'].includes(authHost), 'DocuSign authorization host', 'must match the official demo or production host');
  const apiOrigin = origin(env.API_BASE_URL);
  const appOrigin = origin(env.MARKETING_APP_API_BASE_URL || appEnv.EXPO_PUBLIC_API_BASE_URL);
  report(Boolean(apiOrigin), 'Backend public origin', apiOrigin || 'missing or invalid HTTPS URL');
  report(Boolean(apiOrigin && appOrigin && apiOrigin === appOrigin), 'App/backend alignment', apiOrigin === appOrigin && apiOrigin ? 'origins match' : 'app and backend origins differ or are missing');
  if (online) await Promise.all([database(), schedules(apiOrigin), health(apiOrigin)]);
  console.log('No remote state was changed. Account scopes, delivery, signature conversion, worker transport and device behavior require live acceptance.');
  if (!online) console.log('Add --online for database metadata, QStash schedule and public health reads.');
  process.exitCode = failures ? 1 : 0;
}
main().catch(() => { console.error('Readiness check failed; inspect configuration privately.'); process.exitCode = 1; });
