// ============================================================================
// Seeds src/config/home-banners-seed.json into whichever store is active.
// ----------------------------------------------------------------------------
// Same shape and rules as scripts/seed-explore.js:
//
// IDEMPOTENT: upsertHomeBanner is an INSERT ... ON CONFLICT (id) DO UPDATE that replaces the
// banner's per-locale rows wholesale, so running this twice leaves exactly the same rows — never a
// duplicate. (It also means re-running it puts the seeded banner back the way the seed file says,
// undoing any admin edit to THAT id. Other banners are never touched.)
//
// On Render:  Dashboard -> plyndi-backend -> Shell  ->  npm run seed:banners
// Locally:    DATABASE_URL=postgres://... npm run seed:banners
//
// It deliberately does NOT run on boot or on deploy, and memoryStore.js does not load it either:
// once the admin page exists it is the source of truth, and a server that rewrote banners on
// every start would silently undo its edits.
// ============================================================================

const fs = require('fs');
const path = require('path');

const SEED_PATH = path.join(__dirname, '..', 'src', 'config', 'home-banners-seed.json');

// Best effort, warning only: a seeded banner whose image does not load is an empty box on every
// user's Home screen, and nothing else in this flow would notice.
async function checkImage(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
    const type = res.headers.get('content-type') || '';
    if (!res.ok) return `HTTP ${res.status}`;
    if (!type.startsWith('image/')) return `content-type is "${type}", not an image`;
    return null;
  } catch (err) {
    return err.cause && err.cause.code ? err.cause.code : err.message;
  }
}

async function main() {
  const usingPostgres = Boolean(process.env.DATABASE_URL);
  console.log(
    usingPostgres
      ? '[seed-banners] DATABASE_URL is set — seeding the Postgres store.'
      : '[seed-banners] DATABASE_URL is NOT set — seeding the in-memory store, which disappears ' +
        'when this process exits. That is almost certainly not what you want: set DATABASE_URL, ' +
        'or run this from the Render Shell where it is already set.'
  );

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
  } catch (err) {
    console.error(`[seed-banners] FAILED to read ${SEED_PATH}: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  if (!parsed || !Array.isArray(parsed.banners) || parsed.banners.length === 0) {
    console.error('[seed-banners] FAILED: home-banners-seed.json has no "banners" array.');
    process.exitCode = 1;
    return;
  }

  // Required after the DATABASE_URL check, not before: src/lib/store/index.js picks its adapter
  // at require time.
  const store = require('../src/lib/store');

  let written = 0;
  for (const banner of parsed.banners) {
    try {
      // Same defaults db/schema.sql declares, so a minimal seed entry behaves like a row created
      // through the admin API.
      /* eslint-disable no-await-in-loop */
      await store.upsertHomeBanner({
        ...banner,
        partnerName: banner.partnerName ?? null,
        position: banner.position ?? 0,
        active: banner.active ?? false,
        startsAt: banner.startsAt ?? null,
        endsAt: banner.endsAt ?? null,
        minAppVersion: banner.minAppVersion ?? null,
        imageHasText: banner.imageHasText ?? false,
        textTheme: banner.textTheme ?? 'light',
        targetUrl: banner.targetUrl ?? null,
        navigateTo: banner.navigateTo ?? null,
        requiresUpcomingTrip: banner.requiresUpcomingTrip ?? false,
        locales: banner.locales ?? null,
      });
      written += 1;
      console.log(`[seed-banners]   upserted ${banner.id} (${banner.type}, position ${banner.position}, ${Object.keys(banner.text || {}).length} locale(s))`);
      const images = [['default', banner.imageUrl], ...Object.entries(banner.text || {})
        .filter(([, text]) => text.imageUrl)
        .map(([locale, text]) => [locale, text.imageUrl])];
      for (const [which, url] of images) {
        const problem = await checkImage(url);
        if (problem) {
          console.warn(`[seed-banners]   WARNING: ${banner.id} ${which} image is not reachable (${problem}): ${url}`);
        }
      }
    } catch (err) {
      console.error(`[seed-banners]   FAILED on ${banner.id}: ${err.message}`);
      process.exitCode = 1;
    }
  }

  // Read back through the same path GET /v1/content/home-banners uses, so "success" means the
  // endpoint will actually serve something.
  try {
    const live = await store.listHomeBanners({ locale: 'en', appVersion: null, now: new Date() });
    console.log(`[seed-banners] wrote ${written}/${parsed.banners.length} banner(s); the carousel now returns ${live.length} banner(s).`);
    if (live.length === 0) {
      console.warn('[seed-banners] WARNING: the carousel is still empty — every banner is inactive or outside its starts_at/ends_at window.');
    }
  } catch (err) {
    console.error(`[seed-banners] wrote ${written} banner(s) but the read-back failed: ${err.message}`);
    process.exitCode = 1;
  }
}

main().then(() => {
  // pg keeps its pool open; nothing else is pending, so exit rather than hang.
  process.exit(process.exitCode || 0);
});
