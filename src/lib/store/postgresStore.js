// Postgres-backed storage adapter (Plyndi-AI-Hub-Design.md §4.6) — chosen automatically by
// ./index.js whenever DATABASE_URL is set. Tables live in db/schema.sql; apply them with
// `node scripts/migrate.js` (idempotent, safe to re-run on every deploy) before pointing a real
// DATABASE_URL at a service that expects this adapter to work.
//
// ============================================================================
// UNVERIFIED IN THIS ENVIRONMENT.
// ============================================================================
// This development shell has no local `psql`/`pg_isready` on PATH and cannot reach Render's
// Postgres (or any Postgres) from here. Every query below was written directly against
// db/schema.sql and reviewed line by line, but NONE of it has actually been executed against a
// live server — there is no substitute for that. Before trusting this in production: provision
// Postgres on Render, set DATABASE_URL, run `node scripts/migrate.js`, then exercise a real
// POST /v1/ai/run end to end and confirm a row lands in ai_runs and ai_credit_ledger.
//
// The `pg` module was added as this repo's one permitted new dependency for exactly this file —
// there is no way to speak the Postgres wire protocol without a client library, and `pg` is the
// standard one for Node.

const crypto = require('crypto');
const { Pool } = require('pg');
const { startOfUtcDay } = require('../billingPeriod');

// Lazy: requiring this file must never open a connection by itself (so a test or script that
// merely requires src/lib/store/index.js without DATABASE_URL set is unaffected) — a Pool is only
// constructed the first time a query actually runs.
let pool = null;
function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      // Render's managed Postgres terminates TLS with a certificate this driver can't chain to a
      // known root by default; `rejectUnauthorized: false` is Render's own documented workaround
      // for exactly this. Set PGSSLMODE=disable only for a local, non-TLS Postgres in development.
      ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
    });
    // An idle client erroring in the background (a dropped connection, a Render restart) must not
    // crash the whole process — the pool reconnects on the next query. Same "degrade, never
    // crash" posture providerGateway.js's circuit breaker already takes toward provider outages.
    pool.on('error', (err) => {
      console.error('[store/postgres] idle client error:', err.message);
    });
  }
  return pool;
}

function toRun(row) {
  if (!row) return null;
  return {
    runId: row.id,
    status: row.status,
    capabilityId: row.capability_id,
    capabilityVersion: row.capability_version,
    contextVersion: row.context_version,
    result: row.result_json,
    provider: row.provider,
    model: row.model,
    latencyMs: row.latency_ms,
    createdAtMs: new Date(row.created_at).getTime(),
    idempotencyKey: row.idempotency_key,
    scopeKey: row.scope_key,
    verified: row.verified,
  };
}

async function saveRun(run) {
  // The (scope_key, idempotency_key) unique index in db/schema.sql IS the idempotency guarantee —
  // ON CONFLICT DO NOTHING plus a read-back on the losing side, never a read-then-write check that
  // would have its own race window under concurrent identical requests.
  const insert = await getPool().query(
    `INSERT INTO ai_runs
       (id, scope_key, verified, capability_id, capability_version, context_version, status,
        result_json, provider, model, latency_ms, idempotency_key, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, to_timestamp($13 / 1000.0))
     ON CONFLICT (scope_key, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
     RETURNING *`,
    [
      run.runId,
      run.scopeKey,
      Boolean(run.verified),
      run.capabilityId,
      run.capabilityVersion,
      run.contextVersion,
      run.status,
      run.result === undefined ? null : JSON.stringify(run.result),
      run.provider,
      run.model,
      run.latencyMs,
      run.idempotencyKey,
      run.createdAtMs,
    ]
  );
  if (insert.rows[0]) return toRun(insert.rows[0]);
  return findByIdempotency(run.scopeKey, run.idempotencyKey);
}

async function getRun(runId) {
  const { rows } = await getPool().query('SELECT * FROM ai_runs WHERE id = $1', [runId]);
  return toRun(rows[0]);
}

async function findByIdempotency(scopeKey, idempotencyKey) {
  if (!idempotencyKey) return null;
  const { rows } = await getPool().query(
    'SELECT * FROM ai_runs WHERE scope_key = $1 AND idempotency_key = $2',
    [scopeKey, idempotencyKey]
  );
  return toRun(rows[0]);
}

async function listRuns(scopeKey, limit = 20, cursor = null) {
  const params = [scopeKey, limit];
  let cursorClause = '';
  if (cursor) {
    params.push(cursor);
    cursorClause = 'AND created_at < (SELECT created_at FROM ai_runs WHERE id = $3 AND scope_key = $1)';
  }
  const { rows } = await getPool().query(
    `SELECT * FROM ai_runs WHERE scope_key = $1 ${cursorClause} ORDER BY created_at DESC LIMIT $2`,
    params
  );
  return rows.map(toRun);
}

// entry: { subject, verified, capabilityId, creditCost, runId }
async function recordCredit(entry) {
  const client = getPool();
  await client.query(
    `INSERT INTO ai_credit_ledger (id, scope_key, verified, run_id, capability_id, delta, reason, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'run', now())`,
    [crypto.randomUUID(), entry.subject, Boolean(entry.verified), entry.runId || null, entry.capabilityId, entry.creditCost]
  );
  // Best-effort registry of every subject seen — see db/schema.sql's users_ai comment for why
  // `plan` is hardcoded 'unknown'. Never blocks or fails the credit record on its own account.
  await client.query(
    `INSERT INTO users_ai (scope_key, plan, verified, created_at, updated_at)
     VALUES ($1, 'unknown', $2, now(), now())
     ON CONFLICT (scope_key) DO UPDATE SET verified = EXCLUDED.verified, updated_at = now()`,
    [entry.subject, Boolean(entry.verified)]
  );
}

async function creditsUsed(subject, periodStart) {
  const { rows } = await getPool().query(
    'SELECT COALESCE(SUM(delta), 0) AS total FROM ai_credit_ledger WHERE scope_key = $1 AND created_at >= $2',
    [subject, periodStart]
  );
  return Number(rows[0].total);
}

async function globalSpendToday() {
  const { rows } = await getPool().query(
    'SELECT COALESCE(SUM(delta), 0) AS total FROM ai_credit_ledger WHERE created_at >= $1',
    [startOfUtcDay()]
  );
  return Number(rows[0].total);
}

module.exports = { saveRun, getRun, findByIdempotency, listRuns, recordCredit, creditsUsed, globalSpendToday };
