// Applies db/schema.sql to DATABASE_URL. Idempotent — every statement in that file is
// CREATE ... IF NOT EXISTS, so running this against an already-migrated database (e.g. on every
// Render deploy) is a safe no-op, not an error.
//
// UNVERIFIED IN THIS ENVIRONMENT: this shell has no local Postgres and no network path to
// Render's — there is no `psql`/`pg_isready` on PATH here. This script has been reviewed against
// db/schema.sql but never actually executed against a live server. Run it yourself after
// provisioning DATABASE_URL — see README.md's "AI credits & spend cap" section for the exact
// Render steps — and confirm it prints success before trusting it.
//
// Run: DATABASE_URL=postgres://... node scripts/migrate.js

const fs = require('fs');
const path = require('path');

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is not set. Set it to your Render Postgres connection string first, e.g.:');
    console.error('  DATABASE_URL=postgres://user:pass@host/db node scripts/migrate.js');
    process.exitCode = 1;
    return;
  }

  // Required lazily and only here (not at module load) so nothing else in this repo pays for
  // resolving `pg` unless a migration is actually being run.
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
  });

  const schemaPath = path.join(__dirname, '..', 'db', 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');

  console.log(`[migrate] applying ${schemaPath} ...`);
  try {
    await pool.query(schema);
    console.log('[migrate] done — ai_runs, ai_credit_ledger, users_ai are up to date.');
  } catch (err) {
    console.error('[migrate] FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
