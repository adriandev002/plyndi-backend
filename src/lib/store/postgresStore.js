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
const { compareVersions } = require('../semver');

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
// brief_locale (added Sep 2026, see migrate-brief-locale.sql) records the digest locale the
// cached brief_text was generated in. The digest POST overwrites digest_json — including its
// locale — without touching a generated brief, so after a same-day language switch the row holds
// a new-locale digest next to an old-locale brief. src/routes/aiBrief.js compares the two at
// read time; on mismatch it regenerates and re-saves with replaceBrief=true, which is the ONLY
// path that overwrites an existing brief_text (and re-stamps created_at).
// ---------------------------------------------------------------------------

function toBrief(row) {
  if (!row) return null;
  return {
    subject: row.subject,
    localDate: row.local_date,
    digest: row.digest_json,
    briefText: row.brief_text,
    briefLocale: row.brief_locale,
    provider: row.provider,
    model: row.model,
    createdAtMs: new Date(row.created_at).getTime(),
  };
}

// entry: { subject, localDate, digest?, briefText?, briefLocale?, provider?, model?, replaceBrief? }
async function saveBrief(entry) {
  const { rows } = await getPool().query(
    `INSERT INTO ai_briefs (subject, local_date, digest_json, brief_text, brief_locale, provider, model, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (subject, local_date) DO UPDATE SET
       digest_json = COALESCE(EXCLUDED.digest_json, ai_briefs.digest_json),
       brief_text  = CASE WHEN $8 THEN EXCLUDED.brief_text
                          ELSE COALESCE(ai_briefs.brief_text, EXCLUDED.brief_text) END,
       brief_locale = CASE WHEN $8 THEN EXCLUDED.brief_locale
                           ELSE COALESCE(ai_briefs.brief_locale, EXCLUDED.brief_locale) END,
       provider    = CASE WHEN $8 THEN EXCLUDED.provider
                          ELSE COALESCE(ai_briefs.provider, EXCLUDED.provider) END,
       model       = CASE WHEN $8 THEN EXCLUDED.model
                          ELSE COALESCE(ai_briefs.model, EXCLUDED.model) END,
       created_at  = CASE
                       WHEN $8 THEN now()
                       WHEN ai_briefs.brief_text IS NULL AND EXCLUDED.brief_text IS NOT NULL THEN now()
                       ELSE ai_briefs.created_at
                     END
     RETURNING *`,
    [
      entry.subject,
      entry.localDate,
      entry.digest !== undefined && entry.digest !== null ? JSON.stringify(entry.digest) : null,
      entry.briefText ?? null,
      entry.briefLocale ?? null,
      entry.provider ?? null,
      entry.model ?? null,
      entry.replaceBrief === true,
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

// ---------------------------------------------------------------------------
// Explore feed (Phase 2) — GET /v1/content/explore, GET /r/:cardId, /v1/admin/explore-cards. Same
// identical async surface as memoryStore.js's explore methods; see that file's header comment for
// the shared reasoning (regions NULL = everywhere, a null/unparseable appVersion fails open, text
// falls back to "en"). min_app_version filtering happens in application code, not SQL — the same
// split ai_credit_ledger's queries never attempt, since compareVersions' "1.10.0" vs "1.9.0"
// numeric-not-lexical comparison (src/lib/semver.js) has no direct SQL equivalent.
// ---------------------------------------------------------------------------

function toExploreCard(row, text) {
  return {
    id: row.id,
    type: row.type,
    category: row.category,
    imageUrl: row.image_url,
    imageHeight: row.image_height,
    icon: row.icon,
    targetUrl: row.target_url,
    navigateTo: row.navigate_to,
    minAppVersion: row.min_app_version,
    regions: row.regions,
    weight: row.weight,
    published: row.published,
    publishAt: row.publish_at,
    expiresAt: row.expires_at,
    createdAtMs: new Date(row.created_at).getTime(),
    updatedAtMs: new Date(row.updated_at).getTime(),
    text: text || null,
  };
}

// Unfiltered — every card regardless of published/window/region/version, for
// GET /v1/admin/explore-cards. listExploreCards below is the public, filtered read used by
// GET /v1/content/explore.
async function listAllExploreCards() {
  const { rows } = await getPool().query('SELECT * FROM explore_cards ORDER BY weight DESC, created_at DESC');
  if (!rows.length) return [];
  const ids = rows.map((row) => row.id);
  const { rows: textRows } = await getPool().query('SELECT * FROM explore_card_text WHERE card_id = ANY($1)', [ids]);
  const textByCard = new Map();
  for (const row of textRows) {
    if (!textByCard.has(row.card_id)) textByCard.set(row.card_id, {});
    textByCard.get(row.card_id)[row.locale] = { tag: row.tag, title: row.title, description: row.description, ctaLabel: row.cta_label };
  }
  return rows.map((row) => toExploreCard(row, textByCard.get(row.id) || {}));
}

// Unfiltered single-card lookup by id — used by GET /r/:cardId (a card must still redirect even
// if it has since been unpublished or expired; the link was valid when it was shown) and by the
// admin API's existence checks.
async function getExploreCard(id) {
  const { rows } = await getPool().query('SELECT * FROM explore_cards WHERE id = $1', [id]);
  if (!rows[0]) return null;
  const { rows: textRows } = await getPool().query('SELECT * FROM explore_card_text WHERE card_id = $1', [id]);
  const text = {};
  for (const row of textRows) text[row.locale] = { tag: row.tag, title: row.title, description: row.description, ctaLabel: row.cta_label };
  return toExploreCard(rows[0], text);
}

async function listExploreCards({ locale = 'en', region = null, appVersion = null, now = new Date() } = {}) {
  const nowVal = now instanceof Date ? now : new Date(now);
  // regions IS NULL -> everywhere. Otherwise the caller's region must be non-null AND a member
  // of the card's regions array — an absent/unknown caller region never matches a
  // region-restricted card (see src/routes/content.js's header comment).
  const { rows } = await getPool().query(
    `SELECT * FROM explore_cards
     WHERE published = true
       AND (publish_at IS NULL OR publish_at <= $1)
       AND (expires_at IS NULL OR expires_at > $1)
       AND (regions IS NULL OR ($2::text IS NOT NULL AND $2 = ANY(regions)))
     ORDER BY weight DESC, created_at DESC`,
    [nowVal, region]
  );
  const eligible = rows.filter((row) => compareVersions(appVersion, row.min_app_version) !== -1);
  if (!eligible.length) return [];

  const ids = eligible.map((row) => row.id);
  const { rows: textRows } = await getPool().query(
    'SELECT * FROM explore_card_text WHERE card_id = ANY($1) AND locale = ANY($2)',
    [ids, [locale, 'en']]
  );
  // Prefer the requested locale's row over the "en" fallback row when both exist for a card.
  const textByCard = new Map();
  for (const row of textRows) {
    const preferred = row.locale === locale;
    if (textByCard.has(row.card_id) && !preferred) continue;
    textByCard.set(row.card_id, { tag: row.tag, title: row.title, description: row.description, ctaLabel: row.cta_label });
  }

  return eligible.map((row) => toExploreCard(row, textByCard.get(row.id) || null));
}

// entry: { id, type, category, imageUrl, imageHeight, icon, targetUrl, navigateTo,
//          minAppVersion, regions, weight, published, publishAt, expiresAt, text: { locale: {...} } }
//
// A transaction because this is a card row PLUS a full replace of its text rows — losing power
// between the two would otherwise leave a card with stale or missing text for some locale. text
// rows are DELETEd then re-INSERTed rather than diffed, mirroring memoryStore.js's
// putExploreCardText: an admin PUT always supplies the complete set of locales it wants live, so
// there's no partial-update case to reconcile.
async function upsertExploreCard(card) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO explore_cards
         (id, type, category, image_url, image_height, icon, target_url, navigate_to,
          min_app_version, regions, weight, published, publish_at, expires_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, now())
       ON CONFLICT (id) DO UPDATE SET
         type = EXCLUDED.type,
         category = EXCLUDED.category,
         image_url = EXCLUDED.image_url,
         image_height = EXCLUDED.image_height,
         icon = EXCLUDED.icon,
         target_url = EXCLUDED.target_url,
         navigate_to = EXCLUDED.navigate_to,
         min_app_version = EXCLUDED.min_app_version,
         regions = EXCLUDED.regions,
         weight = EXCLUDED.weight,
         published = EXCLUDED.published,
         publish_at = EXCLUDED.publish_at,
         expires_at = EXCLUDED.expires_at,
         updated_at = now()
       RETURNING *`,
      [
        card.id, card.type, card.category, card.imageUrl ?? null, card.imageHeight, card.icon,
        card.targetUrl ?? null, card.navigateTo ?? null, card.minAppVersion, card.regions ?? null,
        card.weight, card.published, card.publishAt ?? null, card.expiresAt ?? null,
      ]
    );
    await client.query('DELETE FROM explore_card_text WHERE card_id = $1', [card.id]);
    for (const [locale, text] of Object.entries(card.text || {})) {
      await client.query(
        `INSERT INTO explore_card_text (card_id, locale, tag, title, description, cta_label)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [card.id, locale, text.tag, text.title, text.description, text.ctaLabel]
      );
    }
    await client.query('COMMIT');
    return toExploreCard(rows[0], card.text ? card.text.en : null);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function deleteExploreCard(id) {
  // explore_card_text rows cascade via db/schema.sql's ON DELETE CASCADE; explore_clicks rows are
  // deliberately NOT a foreign key (see that table's schema comment) so click history for this id
  // survives the card's deletion.
  const { rowCount } = await getPool().query('DELETE FROM explore_cards WHERE id = $1', [id]);
  return rowCount > 0;
}

async function recordExploreClick({ cardId, region, appVersion }) {
  await getPool().query(
    'INSERT INTO explore_clicks (card_id, region, app_version) VALUES ($1, $2, $3)',
    [cardId, region ?? null, appVersion ?? null]
  );
}

async function exploreClickCounts({ since }) {
  const { rows } = await getPool().query(
    `SELECT card_id, COUNT(*) AS clicks FROM explore_clicks
     WHERE clicked_at >= $1
     GROUP BY card_id
     ORDER BY clicks DESC`,
    [since]
  );
  return rows.map((row) => ({ cardId: row.card_id, clicks: Number(row.clicks) }));
}

// ---------------------------------------------------------------------------
// Home banner carousel — same async surface as memoryStore.js's banner methods and the same split
// as the Explore queries above: SQL narrows to active, in-window rows for this language in
// position order; min_app_version is decided in application code with compareVersions (a NULL
// min fails open).
// ---------------------------------------------------------------------------

function toHomeBanner(row, text) {
  return {
    id: row.id,
    type: row.type,
    partnerName: row.partner_name,
    position: row.position,
    active: row.active,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    minAppVersion: row.min_app_version,
    imageUrl: row.image_url,
    imageHasText: row.image_has_text,
    textTheme: row.text_theme,
    targetUrl: row.target_url,
    navigateTo: row.navigate_to,
    requiresUpcomingTrip: row.requires_upcoming_trip,
    locales: row.locales,
    createdAtMs: new Date(row.created_at).getTime(),
    updatedAtMs: new Date(row.updated_at).getTime(),
    text: text || null,
  };
}

function toBannerTextRow(row) {
  return { title: row.title, subtitle: row.subtitle, ctaLabel: row.cta_label, altText: row.alt_text, imageUrl: row.image_url };
}

async function homeBannerTextFor(ids) {
  const { rows } = await getPool().query('SELECT * FROM home_banner_text WHERE banner_id = ANY($1)', [ids]);
  const textByBanner = new Map();
  for (const row of rows) {
    if (!textByBanner.has(row.banner_id)) textByBanner.set(row.banner_id, {});
    textByBanner.get(row.banner_id)[row.locale] = toBannerTextRow(row);
  }
  return textByBanner;
}

// Unfiltered, for GET /v1/admin/home-banners.
async function listAllHomeBanners() {
  const { rows } = await getPool().query('SELECT * FROM home_banners ORDER BY position ASC, created_at ASC, id ASC');
  if (!rows.length) return [];
  const textByBanner = await homeBannerTextFor(rows.map((row) => row.id));
  return rows.map((row) => toHomeBanner(row, textByBanner.get(row.id) || {}));
}

// Unfiltered single lookup — used by GET /r/banner/:id and the admin API's existence checks.
async function getHomeBanner(id) {
  const { rows } = await getPool().query('SELECT * FROM home_banners WHERE id = $1', [id]);
  if (!rows[0]) return null;
  const textByBanner = await homeBannerTextFor([id]);
  return toHomeBanner(rows[0], textByBanner.get(id) || {});
}

async function listHomeBanners({ locale = 'en', appVersion = null, now = new Date(), limit = 10 } = {}) {
  const nowVal = now instanceof Date ? now : new Date(now);
  // locales IS NULL -> every language; otherwise the requested locale must be one of them.
  const { rows } = await getPool().query(
    `SELECT * FROM home_banners
     WHERE active = true
       AND (starts_at IS NULL OR starts_at <= $1)
       AND (ends_at IS NULL OR ends_at > $1)
       AND (locales IS NULL OR $2 = ANY(locales))
     ORDER BY position ASC, created_at ASC, id ASC`,
    [nowVal, locale]
  );
  const eligible = rows.filter((row) => compareVersions(appVersion, row.min_app_version) !== -1);
  if (!eligible.length) return [];

  const { rows: textRows } = await getPool().query(
    'SELECT * FROM home_banner_text WHERE banner_id = ANY($1) AND locale = ANY($2)',
    [eligible.map((row) => row.id), [locale, 'en']]
  );
  // Prefer the requested locale's row over the "en" fallback row when both exist.
  const textByBanner = new Map();
  for (const row of textRows) {
    if (textByBanner.has(row.banner_id) && row.locale !== locale) continue;
    textByBanner.set(row.banner_id, toBannerTextRow(row));
  }

  return eligible
    .filter((row) => textByBanner.has(row.id)) // no row for this locale and no "en" row -> nothing to show
    .slice(0, limit)
    .map((row) => toHomeBanner(row, textByBanner.get(row.id)));
}

// A transaction for the same reason as upsertExploreCard: a banner row plus a full replace of its
// per-locale rows must land together or not at all.
async function upsertHomeBanner(banner) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO home_banners
         (id, type, partner_name, position, active, starts_at, ends_at, min_app_version, image_url,
          image_has_text, text_theme, target_url, navigate_to, requires_upcoming_trip, locales, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, now())
       ON CONFLICT (id) DO UPDATE SET
         type = EXCLUDED.type,
         partner_name = EXCLUDED.partner_name,
         position = EXCLUDED.position,
         active = EXCLUDED.active,
         starts_at = EXCLUDED.starts_at,
         ends_at = EXCLUDED.ends_at,
         min_app_version = EXCLUDED.min_app_version,
         image_url = EXCLUDED.image_url,
         image_has_text = EXCLUDED.image_has_text,
         text_theme = EXCLUDED.text_theme,
         target_url = EXCLUDED.target_url,
         navigate_to = EXCLUDED.navigate_to,
         requires_upcoming_trip = EXCLUDED.requires_upcoming_trip,
         locales = EXCLUDED.locales,
         updated_at = now()
       RETURNING *`,
      [
        banner.id, banner.type, banner.partnerName ?? null, banner.position, banner.active,
        banner.startsAt ?? null, banner.endsAt ?? null, banner.minAppVersion ?? null, banner.imageUrl,
        banner.imageHasText ?? false, banner.textTheme ?? 'light', banner.targetUrl ?? null,
        banner.navigateTo ?? null, banner.requiresUpcomingTrip ?? false, banner.locales ?? null,
      ]
    );
    await client.query('DELETE FROM home_banner_text WHERE banner_id = $1', [banner.id]);
    for (const [locale, text] of Object.entries(banner.text || {})) {
      await client.query(
        `INSERT INTO home_banner_text (banner_id, locale, title, subtitle, cta_label, alt_text, image_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [banner.id, locale, text.title ?? null, text.subtitle ?? null, text.ctaLabel ?? null, text.altText, text.imageUrl ?? null]
      );
    }
    await client.query('COMMIT');
    const text = {};
    for (const [locale, value] of Object.entries(banner.text || {})) {
      text[locale] = { title: value.title ?? null, subtitle: value.subtitle ?? null, ctaLabel: value.ctaLabel ?? null, altText: value.altText, imageUrl: value.imageUrl ?? null };
    }
    return toHomeBanner(rows[0], text);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function deleteHomeBanner(id) {
  // home_banner_text cascades; clicks and impressions are deliberately not foreign keys, so the
  // banner's history outlives it.
  const { rowCount } = await getPool().query('DELETE FROM home_banners WHERE id = $1', [id]);
  return rowCount > 0;
}

async function recordHomeBannerClick({ bannerId, region, appVersion }) {
  await getPool().query(
    'INSERT INTO home_banner_clicks (banner_id, region, app_version) VALUES ($1, $2, $3)',
    [bannerId, region ?? null, appVersion ?? null]
  );
}

// One statement: the JOIN drops ids that are not a banner, and ON CONFLICT adds to today's row
// rather than replacing it, so concurrent posts from many devices sum correctly.
async function recordHomeBannerImpressions({ counts, day }) {
  const ids = Object.keys(counts);
  if (!ids.length) return 0;
  const { rowCount } = await getPool().query(
    `INSERT INTO home_banner_impressions (banner_id, day, impressions)
     SELECT c.id, $1::date, c.n
     FROM unnest($2::text[], $3::bigint[]) AS c(id, n)
     JOIN home_banners b ON b.id = c.id
     ON CONFLICT (banner_id, day) DO UPDATE
       SET impressions = home_banner_impressions.impressions + EXCLUDED.impressions`,
    [day, ids, ids.map((id) => counts[id])]
  );
  return rowCount;
}

// Impressions and clicks per banner for the UTC days fromDay..toDay (YYYY-MM-DD, inclusive).
async function homeBannerStats({ fromDay, toDay }) {
  const fromTs = new Date(`${fromDay}T00:00:00Z`);
  const toTs = new Date(Date.parse(`${toDay}T00:00:00Z`) + 24 * 60 * 60 * 1000);
  const [{ rows: impressionRows }, { rows: clickRows }] = await Promise.all([
    getPool().query(
      `SELECT banner_id, SUM(impressions) AS impressions FROM home_banner_impressions
       WHERE day >= $1::date AND day <= $2::date GROUP BY banner_id`,
      [fromDay, toDay]
    ),
    getPool().query(
      `SELECT banner_id, COUNT(*) AS clicks FROM home_banner_clicks
       WHERE clicked_at >= $1 AND clicked_at < $2 GROUP BY banner_id`,
      [fromTs, toTs]
    ),
  ]);
  const stats = new Map();
  const row = (id) => {
    if (!stats.has(id)) stats.set(id, { bannerId: id, impressions: 0, clicks: 0 });
    return stats.get(id);
  };
  for (const r of impressionRows) row(r.banner_id).impressions = Number(r.impressions);
  for (const r of clickRows) row(r.banner_id).clicks = Number(r.clicks);
  return [...stats.values()];
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
  listExploreCards,
  listAllExploreCards,
  getExploreCard,
  upsertExploreCard,
  deleteExploreCard,
  recordExploreClick,
  exploreClickCounts,
  listHomeBanners,
  listAllHomeBanners,
  getHomeBanner,
  upsertHomeBanner,
  deleteHomeBanner,
  recordHomeBannerClick,
  recordHomeBannerImpressions,
  homeBannerStats,
};
