// Storage adapter factory (Plyndi-AI-Hub-Design.md §4.6, Phase 3-A). Chooses memoryStore.js or
// postgresStore.js by DATABASE_URL's presence alone, decided once at boot — both implementations
// share the exact same async method surface (saveRun, getRun, findByIdempotency, listRuns,
// recordCredit, creditsUsed, globalSpendToday), so every caller (src/routes/aiRun.js,
// src/routes/aiEntitlement.js) is written against this module and never against either adapter
// directly.
//
// A missing DATABASE_URL must NOT take the AI Hub down — it falls back to the in-memory adapter
// and logs loudly that runs/credits will not survive a restart, rather than refusing to boot. The
// AI Hub is the app's Premium screen; a missing database is a real problem worth fixing, but it is
// not a reason to serve nothing.

const memoryStore = require('./memoryStore');

let chosen = null;

function getStore() {
  if (chosen) return chosen;

  if (process.env.DATABASE_URL) {
    // Required lazily, and only once DATABASE_URL is actually set, so an environment with no `pg`
    // network access (this development shell included) never pays for it unless Postgres is
    // actually configured.
    chosen = require('./postgresStore');
    console.log('[store] DATABASE_URL is set — using the Postgres-backed store (src/lib/store/postgresStore.js). Runs and credits are durable.');
  } else {
    chosen = memoryStore;
    console.warn(
      '[store] DATABASE_URL is NOT set — using the IN-MEMORY store (src/lib/store/memoryStore.js). ' +
      'Runs and the credit ledger are NOT durable and will be lost on every restart/redeploy. ' +
      'Set DATABASE_URL to a Render Postgres instance and run `node scripts/migrate.js` before relying on credits or run history.'
    );
  }
  return chosen;
}

module.exports = getStore();
