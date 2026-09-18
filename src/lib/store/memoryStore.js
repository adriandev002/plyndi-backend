// IN-MEMORY storage adapter — chosen automatically by ./index.js whenever DATABASE_URL is unset,
// and the ONLY adapter every test in this repo runs against (this shell has no local Postgres and
// cannot reach Render's — see postgresStore.js's header comment). Its run-storage half is the
// Phase 1-A runStore.js this replaces, unchanged in behaviour (bounded + TTL, NOT durable — same
// reasoning already documented against /v1/sync's filesystem adapter: Render's own disk isn't
// durable either, so pretending an in-process store is a real substitute for Postgres would be
// worse than being honest that everything here resets on restart/redeploy). The credit-ledger half
// is new for Phase 3-A.
//
// Every method returns a Promise so route code can `await store.foo(...)` identically regardless
// of which adapter src/lib/store/index.js chose — see postgresStore.js for the real one.

const { startOfUtcDay } = require('../billingPeriod');

const MAX_RUNS = Number(process.env.AI_RUN_STORE_MAX || 500);
const RUN_TTL_MS = Number(process.env.AI_RUN_STORE_TTL_MS || 24 * 60 * 60 * 1000);
// Ledger entries need to survive at least one full monthly billing period lookup (see
// creditsUsed() below) — 35 days covers every month with room to spare. Bounded on top of that so
// a long-lived process's memory doesn't grow forever; NOT a substitute for Postgres's indefinite
// ledger retention (Plyndi-AI-Hub-Design.md §4.6 — the ledger is the billing record).
const MAX_LEDGER_ENTRIES = Number(process.env.AI_CREDIT_LEDGER_MAX || 20000);
const LEDGER_TTL_MS = Number(process.env.AI_CREDIT_LEDGER_TTL_MS || 35 * 24 * 60 * 60 * 1000);

const runs = new Map(); // runId -> run
const idempotencyIndex = new Map(); // "<scopeKey>:<idempotencyKey>" -> runId
let ledger = []; // credit ledger entries, insertion order (oldest first)

function idempotencyKeyFor(scopeKey, idempotencyKey) {
  return `${scopeKey}:${idempotencyKey}`;
}

function purgeExpiredRuns() {
  const now = Date.now();
  for (const [runId, run] of runs) {
    if (now - run.createdAtMs > RUN_TTL_MS) {
      runs.delete(runId);
      if (run.idempotencyKey) idempotencyIndex.delete(idempotencyKeyFor(run.scopeKey, run.idempotencyKey));
    }
  }
}

function evictOldestRunsIfOverCapacity() {
  // Map iterates in insertion order, so the first key is the oldest saved run.
  while (runs.size > MAX_RUNS) {
    const oldestRunId = runs.keys().next().value;
    const oldest = runs.get(oldestRunId);
    runs.delete(oldestRunId);
    if (oldest && oldest.idempotencyKey) idempotencyIndex.delete(idempotencyKeyFor(oldest.scopeKey, oldest.idempotencyKey));
  }
}

function purgeExpiredLedger() {
  const cutoff = Date.now() - LEDGER_TTL_MS;
  if (!ledger.length || ledger[0].createdAtMs >= cutoff) return; // fast path: nothing expired yet
  ledger = ledger.filter((entry) => entry.createdAtMs >= cutoff);
}

async function saveRun(run) {
  purgeExpiredRuns();
  runs.set(run.runId, run);
  if (run.idempotencyKey) {
    idempotencyIndex.set(idempotencyKeyFor(run.scopeKey, run.idempotencyKey), run.runId);
  }
  evictOldestRunsIfOverCapacity();
  return run;
}

async function getRun(runId) {
  purgeExpiredRuns();
  return runs.get(runId) || null;
}

async function findByIdempotency(scopeKey, idempotencyKey) {
  if (!idempotencyKey) return null;
  purgeExpiredRuns();
  const runId = idempotencyIndex.get(idempotencyKeyFor(scopeKey, idempotencyKey));
  return runId ? runs.get(runId) || null : null;
}

async function listRuns(scopeKey, limit = 20, cursor = null) {
  purgeExpiredRuns();
  const scoped = [...runs.values()]
    .filter((run) => run.scopeKey === scopeKey)
    .sort((a, b) => b.createdAtMs - a.createdAtMs);
  const startIndex = cursor ? scoped.findIndex((run) => run.runId === cursor) + 1 : 0;
  return scoped.slice(startIndex, startIndex + limit);
}

// entry: { subject, verified, capabilityId, creditCost, runId }
async function recordCredit(entry) {
  purgeExpiredLedger();
  ledger.push({
    scopeKey: entry.subject,
    verified: Boolean(entry.verified),
    capabilityId: entry.capabilityId,
    delta: entry.creditCost,
    runId: entry.runId || null,
    createdAtMs: Date.now(),
  });
  if (ledger.length > MAX_LEDGER_ENTRIES) {
    ledger = ledger.slice(ledger.length - MAX_LEDGER_ENTRIES);
  }
}

async function creditsUsed(subject, periodStart) {
  purgeExpiredLedger();
  const cutoffMs = periodStart instanceof Date ? periodStart.getTime() : new Date(periodStart).getTime();
  return ledger.reduce((sum, entry) => (
    entry.scopeKey === subject && entry.createdAtMs >= cutoffMs ? sum + entry.delta : sum
  ), 0);
}

// Deliberately NOT scoped by subject — this is the global cap, summed across every caller for the
// current UTC day (Plyndi-AI-Hub-Design.md §4.5's spend-cap row).
async function globalSpendToday() {
  purgeExpiredLedger();
  const cutoffMs = startOfUtcDay().getTime();
  return ledger.reduce((sum, entry) => (entry.createdAtMs >= cutoffMs ? sum + entry.delta : sum), 0);
}

// Test-only reset so scripts/test-ai-credits.js can start each scenario from a clean ledger, the
// same way scripts/test-ai-run.js already resets providerGateway's circuit breaker between cases.
// Production code never calls this.
function _resetForTests() {
  runs.clear();
  idempotencyIndex.clear();
  ledger = [];
}

module.exports = {
  saveRun,
  getRun,
  findByIdempotency,
  listRuns,
  recordCredit,
  creditsUsed,
  globalSpendToday,
  _resetForTests,
};
