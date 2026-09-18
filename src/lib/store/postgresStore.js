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

// entry: { subject, verified, capabilityId, creditCost, runId, countsTowardAllowance? }
// `countsTowardAllowance` defaults to true (every pre-Phase-4-A caller, i.e. POST /v1/ai/run,
// never passes it). Phase 4-A's daily_brief passes false: real provider spend (globalSpendToday()
// below is unscoped and always sums every row, regardless of this flag) that must NOT draw down
// any subject's monthly allowance (creditsUsed() filters on it) — the brief is free for everyone
// (Plyndi-AI-Hub-Design.md §6). See db/schema.sql's counts_toward_allowance column comment.
async function recordCredit(entry) {
  const client = getPool();
  await client.query(
    `INSERT INTO ai_credit_ledger (id, scope_key, verified, run_id, capability_id, delta, reason, counts_toward_allowance, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'run', $7, now())`,
    [
      crypto.randomUUID(),
      entry.subject,
      Boolean(entry.verified),
      entry.runId || null,
      entry.capabilityId,
      entry.creditCost,
      entry.countsTowardAllowance !== false,
    ]
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
    'SELECT COALESCE(SUM(delta), 0) AS total FROM ai_credit_ledger WHERE scope_key = $1 AND created_at >= $2 AND counts_toward_allowance = true',
    [subject, periodStart]
  );
  return Number(rows[0].total);
}

// Deliberately NOT filtered by counts_toward_allowance — every row here is real provider spend
// regardless of whether it draws down a subject's monthly allowance, and the global cap exists to
// bound real spend (Plyndi-AI-Hub-Design.md §4.5).
async function globalSpendToday() {
  const { rows } = await getPool().query(
    'SELECT COALESCE(SUM(delta), 0) AS total FROM ai_credit_ledger WHERE created_at >= $1',
    [startOfUtcDay()]
  );
  return Number(rows[0].total);
}

// ---------------------------------------------------------------------------
// Phase 4-A (Plyndi-AI-Hub-Design.md §3.1, §4.6) — Daily Brief cache. See db/schema.sql's
// ai_briefs comment: PRIMARY KEY (subject, local_date) is the once-per-user-per-day guarantee,
// relied on here via ON CONFLICT, never a read-then-write check (same reasoning saveRun's
// idempotency handling already documents above).
//
// digest_json is overwritten whenever the caller supplies one (COALESCE picks EXCLUDED first) —
// a digest repost always takes effect. brief_text/provider/model are the opposite: COALESCE picks
// the EXISTING row's value first, so once a brief has been generated, nothing written afterward
// (including a same-day digest repost, which passes brief_text=NULL) can ever blank or replace
// it. This single upsert serves both src/routes/aiBrief.js call sites — the digest-only POST and
// the generate-once-per-day GET — with no second method needed.
//
// created_at is what src/routes/aiBrief.js reports as `generatedAt`, so it must track the moment
// a brief was actually GENERATED, not the moment the row was first created by a digest-only POST
// (which is what a plain, untouched DEFAULT now() would give it forever after). The CASE below
// only stamps it to now() at the exact update where brief_text transitions from NULL to non-NULL;
// every other upsert (digest-only insert, a same-day digest repost, a losing write in the
// two-concurrent-GETs race documented in src/routes/aiBrief.js) leaves it untouched.
// ---------------------------------------------------------------------------

function toBrief(row) {
  if (!row) return null;
  return {
    subject: row.subject,
    localDate: row.local_date,
    digest: row.digest_json,
    briefText: row.brief_text,
    provider: row.provider,
    model: row.model,
    createdAtMs: new Date(row.created_at).getTime(),
  };
}

// entry: { subject, localDate, digest?, briefText?, provider?, model? }
async function saveBrief(entry) {
  const { rows } = await getPool().query(
    `INSERT INTO ai_briefs (subject, local_date, digest_json, brief_text, provider, model, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (subject, local_date) DO UPDATE SET
       digest_json = COALESCE(EXCLUDED.digest_json, ai_briefs.digest_json),
       brief_text  = COALESCE(ai_briefs.brief_text, EXCLUDED.brief_text),
       provider    = COALESCE(ai_briefs.provider, EXCLUDED.provider),
       model       = COALESCE(ai_briefs.model, EXCLUDED.model),
       created_at  = CASE
                       WHEN ai_briefs.brief_text IS NULL AND EXCLUDED.brief_text IS NOT NULL THEN now()
                       ELSE ai_briefs.created_at
                     END
     RETURNING *`,
    [
      entry.subject,
      entry.localDate,
      entry.digest !== undefined && entry.digest !== null ? JSON.stringify(entry.digest) : null,
      entry.briefText ?? null,
      entry.provider ?? null,
      entry.model ?? null,
    ]
  );
  return toBrief(rows[0]);
}

async function getBrief(subject, localDate) {
  const { rows } = await getPool().query(
    'SELECT * FROM ai_briefs WHERE subject = $1 AND local_date = $2',
    [subject, localDate]
  );
  return toBrief(rows[0]);
}

module.exports = {
  saveRun,
  getRun,
  findByIdempotency,
  listRuns,
  recordCredit,
  creditsUsed,
  globalSpendToday,
  saveBrief,
  getBrief,
};
