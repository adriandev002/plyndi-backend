// TEMPORARY IN-MEMORY IMPLEMENTATION. Phase 3 (Plyndi-AI-Hub-Design.md §4.6) replaces this with
// Render Postgres (the `ai_runs` table). RENDER'S OWN DISK IS NOT DURABLE, so a file-backed store
// on this host would NOT be an acceptable substitute for Postgres in the meantime — it would look
// durable in development and then lose every run on the next deploy/restart, the same trap
// already flagged against /v1/sync's filesystem adapter. This store is deliberately in memory,
// bounded, and short-lived (TTL) until Postgres lands.
//
// There is no per-user identity until Phase 3 (JWT + entitlement). Runs are scoped by a single
// coarse `scopeKey` the caller supplies — src/routes/aiRun.js currently passes one constant value
// for every request, so idempotency and listing are effectively per-deployment, not per-user, for
// now. This function signature already takes a scope key so swapping in a real per-user id later
// (once Phase 3's JWT lands) is a one-line change at the call site, not a store rewrite.

const MAX_RUNS = Number(process.env.AI_RUN_STORE_MAX || 500);
const TTL_MS = Number(process.env.AI_RUN_STORE_TTL_MS || 24 * 60 * 60 * 1000);

const runs = new Map(); // runId -> run
const idempotencyIndex = new Map(); // "<scopeKey>:<idempotencyKey>" -> runId

function idempotencyKeyFor(scopeKey, idempotencyKey) {
  return `${scopeKey}:${idempotencyKey}`;
}

function purgeExpired() {
  const now = Date.now();
  for (const [runId, run] of runs) {
    if (now - run.createdAtMs > TTL_MS) {
      runs.delete(runId);
      if (run.idempotencyKey) idempotencyIndex.delete(idempotencyKeyFor(run.scopeKey, run.idempotencyKey));
    }
  }
}

function evictOldestIfOverCapacity() {
  // Map iterates in insertion order, so the first key is the oldest saved run.
  while (runs.size > MAX_RUNS) {
    const oldestRunId = runs.keys().next().value;
    const oldest = runs.get(oldestRunId);
    runs.delete(oldestRunId);
    if (oldest && oldest.idempotencyKey) idempotencyIndex.delete(idempotencyKeyFor(oldest.scopeKey, oldest.idempotencyKey));
  }
}

function save(run) {
  purgeExpired();
  runs.set(run.runId, run);
  if (run.idempotencyKey) {
    idempotencyIndex.set(idempotencyKeyFor(run.scopeKey, run.idempotencyKey), run.runId);
  }
  evictOldestIfOverCapacity();
  return run;
}

function get(runId) {
  purgeExpired();
  return runs.get(runId) || null;
}

function findByIdempotencyKey(scopeKey, idempotencyKey) {
  if (!idempotencyKey) return null;
  purgeExpired();
  const runId = idempotencyIndex.get(idempotencyKeyFor(scopeKey, idempotencyKey));
  return runId ? runs.get(runId) || null : null;
}

function listByUser(scopeKey, limit = 20, cursor = null) {
  purgeExpired();
  const scoped = [...runs.values()]
    .filter((run) => run.scopeKey === scopeKey)
    .sort((a, b) => b.createdAtMs - a.createdAtMs);
  const startIndex = cursor ? scoped.findIndex((run) => run.runId === cursor) + 1 : 0;
  return scoped.slice(startIndex, startIndex + limit);
}

module.exports = { save, get, findByIdempotencyKey, listByUser };
