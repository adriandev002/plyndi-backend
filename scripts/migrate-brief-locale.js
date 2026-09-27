// One-off migration: Daily Brief locale-aware cache (Sep 2026).
// Adds the brief_locale column to ai_briefs so a same-day language switch
// regenerates the cached brief instead of serving the previous language.
// Idempotent — ADD COLUMN IF NOT EXISTS, safe to run twice.
//
// Run: DATABASE_URL=postgres://... node scripts/migrate-brief-locale.js

const { Pool } = require('pg');

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is not set. Example:');
    console.error("  DATABASE_URL='postgres://user:pass@host/db' node scripts/migrate-brief-locale.js");
    process.exitCode = 1;
    return;
  }
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
  });
  try {
    await pool.query('ALTER TABLE ai_briefs ADD COLUMN IF NOT EXISTS brief_locale TEXT');
    const { rows } = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'ai_briefs' AND column_name = 'brief_locale'"
    );
    if (rows.length === 1) {
      console.log('[migrate-brief-locale] OK — ai_briefs.brief_locale exists');
    } else {
      console.error('[migrate-brief-locale] FAILED — column not found after ALTER');
      process.exitCode = 1;
    }
  } catch (err) {
    console.error('[migrate-brief-locale] FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
