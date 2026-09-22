// ============================================================================
// Seeds src/config/explore-seed.json into whichever store is active.
// ----------------------------------------------------------------------------
// WHY THIS EXISTS: `loadExploreSeed()` lives in src/lib/store/memoryStore.js and runs at module
// load, so the boot log prints "[explore] loaded explore-seed.json — 3 card(s)" on EVERY deploy —
// including deploys where DATABASE_URL is set and the active store is Postgres. On those deploys
// the seed went into in-memory maps nothing reads, and `GET /v1/content/explore` correctly
// returned an empty feed from three empty Postgres tables. The boot line looked like success.
//
// Run this once after the explore tables are migrated, and again whenever explore-seed.json
// changes. It is IDEMPOTENT: `upsertExploreCard` is an INSERT ... ON CONFLICT (id) DO UPDATE, and
// it replaces that card's text rows wholesale, so running it twice is a no-op rather than a
// duplicate.
//
// On Render:  Dashboard -> plyndi-backend -> Shell  ->  npm run seed:explore
// Locally:    DATABASE_URL=postgres://... npm run seed:explore
//
// It deliberately does NOT run on boot. A server that writes content rows every time it starts
// would silently undo any edit made through /v1/admin/* — the admin page is meant to be the
// source of truth once it exists, and the seed is only the starting point.
// ============================================================================

const fs = require('fs');
const path = require('path');

const SEED_PATH = path.join(__dirname, '..', 'src', 'config', 'explore-seed.json');

async function main() {
  const usingPostgres = Boolean(process.env.DATABASE_URL);
  console.log(
    usingPostgres
      ? '[seed-explore] DATABASE_URL is set — seeding the Postgres store.'
      : '[seed-explore] DATABASE_URL is NOT set — seeding the in-memory store, which disappears ' +
        'when this process exits. That is almost certainly not what you want: set DATABASE_URL, ' +
        'or run this from the Render Shell where it is already set.'
  );

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
  } catch (err) {
    console.error(`[seed-explore] FAILED to read ${SEED_PATH}: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  if (!parsed || !Array.isArray(parsed.cards) || parsed.cards.length === 0) {
    console.error('[seed-explore] FAILED: explore-seed.json has no "cards" array.');
    process.exitCode = 1;
    return;
  }

  // Required after the require, not before: src/lib/store/index.js decides which adapter to use
  // at require time, from DATABASE_URL.
  const store = require('../src/lib/store');

  let written = 0;
  for (const card of parsed.cards) {
    try {
      // Fill in the same defaults db/schema.sql declares, so a minimal seed entry behaves like a
      // row inserted through the admin API.
      /* eslint-disable no-await-in-loop */
      await store.upsertExploreCard({
        ...card,
        imageHeight: card.imageHeight ?? 160,
        minAppVersion: card.minAppVersion ?? '0.0.0',
        weight: card.weight ?? 0,
        published: card.published ?? false,
      });
      written += 1;
      console.log(`[seed-explore]   upserted ${card.id} (${card.type}, ${Object.keys(card.text || {}).length} locales)`);
    } catch (err) {
      console.error(`[seed-explore]   FAILED on ${card.id}: ${err.message}`);
      process.exitCode = 1;
    }
  }

  // Read back through the same path the API uses, so a "success" here means the endpoint will
  // actually serve something — not merely that the writes did not throw.
  try {
    const live = await store.listExploreCards({
      locale: 'en',
      region: null,
      appVersion: null,
      now: new Date(),
    });
    console.log(`[seed-explore] wrote ${written}/${parsed.cards.length} card(s); the feed now returns ${live.length} published card(s).`);
    if (live.length === 0) {
      console.warn(
        '[seed-explore] WARNING: the feed is still empty. Every seeded card has "published": false, ' +
        'or all of them are outside their publish_at/expires_at window.'
      );
    }
  } catch (err) {
    console.error(`[seed-explore] wrote ${written} card(s) but the read-back failed: ${err.message}`);
    process.exitCode = 1;
  }
}

main().then(() => {
  // pg keeps its pool open; nothing else is pending, so exit rather than hang.
  process.exit(process.exitCode || 0);
});
