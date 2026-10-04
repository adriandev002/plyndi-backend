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

const fs = require('fs');
const path = require('path');
const { startOfUtcDay } = require('../billingPeriod');
const { compareVersions } = require('../semver');
const { isValidNavigateTo } = require('../exploreDestinations');
const { byPosition: bannerOrder } = require('../homeBanners');

const MAX_RUNS = Number(process.env.AI_RUN_STORE_MAX || 500);
const RUN_TTL_MS = Number(process.env.AI_RUN_STORE_TTL_MS || 24 * 60 * 60 * 1000);
// Ledger entries need to survive at least one full monthly billing period lookup (see
// creditsUsed() below) — 35 days covers every month with room to spare. Bounded on top of that so
// a long-lived process's memory doesn't grow forever; NOT a substitute for Postgres's indefinite
// ledger retention (Plyndi-AI-Hub-Design.md §4.6 — the ledger is the billing record).
const MAX_LEDGER_ENTRIES = Number(process.env.AI_CREDIT_LEDGER_MAX || 20000);
const LEDGER_TTL_MS = Number(process.env.AI_CREDIT_LEDGER_TTL_MS || 35 * 24 * 60 * 60 * 1000);
// Phase 4-A (Plyndi-AI-Hub-Design.md §4.6) — briefs are retained ~90 days per the design doc;
// bounded on top of that the same way MAX_RUNS/MAX_LEDGER_ENTRIES are, so a long-lived process
// without DATABASE_URL doesn't grow this map forever.
const MAX_BRIEFS = Number(process.env.AI_BRIEF_STORE_MAX || 5000);
const BRIEF_TTL_MS = Number(process.env.AI_BRIEF_STORE_TTL_MS || 90 * 24 * 60 * 60 * 1000);

const runs = new Map(); // runId -> run
const idempotencyIndex = new Map(); // "<scopeKey>:<idempotencyKey>" -> runId
let ledger = []; // credit ledger entries, insertion order (oldest first)
// Phase 3-B — server-verified Premium entitlements (src/lib/entitlement.js). One entry per
// subject; a re-verified subscription overwrites the old row, which is exactly what the app's
// per-launch JWS re-sync wants. Keyed by the same subject src/lib/subject.js resolves for
// the credit ledger, so plan and ledger can never disagree about "who".
const entitlements = new Map(); // subject -> { productId, originalTransactionId, expiresAtMs, revokedAtMs, bundleId, verifiedAtMs }
const briefs = new Map(); // "<subject>::<localDate>" -> { subject, localDate, digest, briefText, briefLocale, provider, model, createdAtMs }

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

// entry: { subject, verified, capabilityId, creditCost, runId, countsTowardAllowance? }
// `countsTowardAllowance` defaults to true (every pre-Phase-4-A caller, i.e. POST /v1/ai/run, never
// passes it) — Phase 4-A's daily_brief passes false: it's real provider spend (globalSpendToday()
// below is unscoped and always sums every row regardless of this flag) but must NOT draw down any
// subject's monthly allowance (creditsUsed() filters on it), since the brief is free for everyone
// (Plyndi-AI-Hub-Design.md §6).
async function recordCredit(entry) {
  purgeExpiredLedger();
  ledger.push({
    scopeKey: entry.subject,
    verified: Boolean(entry.verified),
    capabilityId: entry.capabilityId,
    delta: entry.creditCost,
    runId: entry.runId || null,
    countsTowardAllowance: entry.countsTowardAllowance !== false,
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
    entry.scopeKey === subject && entry.countsTowardAllowance && entry.createdAtMs >= cutoffMs ? sum + entry.delta : sum
  ), 0);
}

// Deliberately NOT scoped by subject — this is the global cap, summed across every caller for the
// current UTC day (Plyndi-AI-Hub-Design.md §4.5's spend-cap row). Deliberately NOT filtered by
// countsTowardAllowance either — every row here is real provider spend regardless of whether it
// draws down a subject's monthly allowance, and the global cap exists to bound real spend.
async function globalSpendToday() {
  purgeExpiredLedger();
  const cutoffMs = startOfUtcDay().getTime();
  return ledger.reduce((sum, entry) => (entry.createdAtMs >= cutoffMs ? sum + entry.delta : sum), 0);
}

// ---------------------------------------------------------------------------
// Phase 3-B — server-verified Premium entitlements. Written ONLY by
// POST /v1/ai/entitlement/verify after src/lib/entitlement.js's verifySignedTransaction()
// has cryptographically verified a StoreKit 2 signed transaction; read ONLY by
// resolvePlan() in that same module. Nothing here ever trusts a client claim — see that
// file's header comment for the full trust story.
// ---------------------------------------------------------------------------

// entry: { productId, originalTransactionId?, expiresAtMs?, revokedAtMs?, bundleId? }
async function saveEntitlement(subject, entry) {
  entitlements.set(subject, {
    productId: entry.productId,
    originalTransactionId: entry.originalTransactionId || null,
    expiresAtMs: entry.expiresAtMs == null ? null : Number(entry.expiresAtMs),
    revokedAtMs: entry.revokedAtMs == null ? null : Number(entry.revokedAtMs),
    bundleId: entry.bundleId || null,
    verifiedAtMs: Date.now(),
  });
}

async function getEntitlement(subject) {
  const ent = entitlements.get(subject);
  return ent ? { ...ent } : null;
}

// ---------------------------------------------------------------------------
// Phase 4-A (Plyndi-AI-Hub-Design.md §3.1, §4.6) — Daily Brief cache, keyed by (subject,
// localDate). ONE row/entry per user per USER-LOCAL day, never UTC — see
// src/routes/aiBrief.js's header comment for why. `saveBrief` is a single upsert entry point used
// from two different call sites with different fields populated:
//   - POST /v1/ai/brief/digest passes { subject, localDate, digest } only (briefText/provider/
//     model omitted) — it must NEVER overwrite an already-generated brief.
//   - GET /v1/ai/brief's generation path passes { subject, localDate, briefText, provider, model }
//     (digest omitted) once a brief has actually been produced.
// A field is only overwritten when the caller actually supplies it (not undefined/null); this is
// what gives "brief_text, once set, is never cleared by a later digest POST" for free, without a
// second method or a read-then-write check.
// ---------------------------------------------------------------------------

function briefKey(subject, localDate) {
  return `${subject}::${localDate}`;
}

function purgeExpiredBriefs() {
  const cutoff = Date.now() - BRIEF_TTL_MS;
  for (const [key, brief] of briefs) {
    if (brief.createdAtMs < cutoff) briefs.delete(key);
  }
  while (briefs.size > MAX_BRIEFS) {
    const oldestKey = briefs.keys().next().value;
    briefs.delete(oldestKey);
  }
}

// entry: { subject, localDate, digest?, briefText?, briefLocale?, provider?, model?, replaceBrief? }
//
// `createdAtMs` is what src/routes/aiBrief.js reports as `generatedAt` — it must reflect the
// moment a brief was actually GENERATED, not the moment the row was first created by a
// digest-only POST. It's therefore only ever stamped to `Date.now()` at the exact upsert where
// briefText transitions from unset to set (or on the replaceBrief overwrite path below);
// every other upsert (a digest-only insert, a same-day digest repost, a losing write in the
// two-concurrent-GETs race documented in src/routes/aiBrief.js) leaves it untouched.
//
// `replaceBrief === true` (set only by src/routes/aiBrief.js's locale-change regeneration
// path) force-overwrites briefText/briefLocale/provider/model and re-stamps createdAtMs,
// even when a brief already exists. Otherwise first-write-wins is preserved exactly.
async function saveBrief(entry) {
  purgeExpiredBriefs();
  const key = briefKey(entry.subject, entry.localDate);
  const existing = briefs.get(key);
  const replacing = entry.replaceBrief === true;
  const hadBrief = Boolean(existing && existing.briefText != null);
  const generatingNow = (!hadBrief && entry.briefText != null) || replacing;
  const merged = {
    subject: entry.subject,
    localDate: entry.localDate,
    digest: entry.digest !== undefined ? entry.digest : (existing ? existing.digest : null),
    briefText: replacing ? (entry.briefText ?? null) : (hadBrief ? existing.briefText : (entry.briefText ?? null)),
    briefLocale: replacing ? (entry.briefLocale ?? null) : (existing ? (existing.briefLocale ?? entry.briefLocale ?? null) : (entry.briefLocale ?? null)),
    provider: replacing ? (entry.provider ?? null) : (hadBrief ? existing.provider : (entry.provider ?? null)),
    model: replacing ? (entry.model ?? null) : (hadBrief ? existing.model : (entry.model ?? null)),
    createdAtMs: generatingNow ? Date.now() : (existing ? existing.createdAtMs : Date.now()),
  };
  briefs.set(key, merged);
  return merged;
}

async function getBrief(subject, localDate) {
  purgeExpiredBriefs();
  return briefs.get(briefKey(subject, localDate)) || null;
}

// ---------------------------------------------------------------------------
// Explore feed (Phase 2) — GET /v1/content/explore, GET /r/:cardId, /v1/admin/explore-cards.
// Same boot-load + validate + permissive-on-failure convention src/routes/config.js and
// src/routes/aiHub.js already use for their own on-disk JSON, applied here to seed this
// DATABASE_URL-less store from src/config/explore-seed.json instead of starting empty: a
// deploy with no Postgres configured should still serve the three cards the app ships today,
// not a blank Explore tab.
//
// exploreCards holds one entry per card, camelCase, WITHOUT its text (text is resolved per
// request by locale — see listExploreCards). exploreCardText is keyed "<cardId>::<locale>" so a
// card's full set of locales is just prefix membership, not a nested structure to keep in sync.
// ---------------------------------------------------------------------------

const EXPLORE_SEED_PATH = path.join(__dirname, '..', '..', 'config', 'explore-seed.json');
const EXPLORE_CARD_TYPES = new Set(['editorial', 'affiliate', 'firstParty']);
const EXPLORE_CARD_CATEGORIES = new Set(['travel', 'hotels', 'lifestyle']);

const exploreCards = new Map(); // id -> card fields (no `text`)
const exploreCardText = new Map(); // "<cardId>::<locale>" -> { tag, title, description, ctaLabel }
let exploreClicks = []; // { id, cardId, clickedAt: Date, region, appVersion }
let exploreClickSeq = 1;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isValidExploreText(value) {
  return (
    value !== null && typeof value === 'object' &&
    isNonEmptyString(value.tag) && isNonEmptyString(value.title) &&
    isNonEmptyString(value.description) && isNonEmptyString(value.ctaLabel)
  );
}

// The seed (and every admin upsert) must carry an "en" text entry — it's the fallback every
// other locale resolves to, so a card missing it would silently disappear for any locale it
// doesn't explicitly cover.
function isValidExploreCardShape(card) {
  return (
    card !== null && typeof card === 'object' &&
    isNonEmptyString(card.id) &&
    EXPLORE_CARD_TYPES.has(card.type) &&
    EXPLORE_CARD_CATEGORIES.has(card.category) &&
    (card.imageUrl === null || card.imageUrl === undefined || isNonEmptyString(card.imageUrl)) &&
    Number.isFinite(card.imageHeight) &&
    isNonEmptyString(card.icon) &&
    (card.targetUrl === null || card.targetUrl === undefined || isNonEmptyString(card.targetUrl)) &&
    (card.navigateTo === null || card.navigateTo === undefined || isValidNavigateTo(card.navigateTo)) &&
    isNonEmptyString(card.minAppVersion) &&
    (card.regions === null || card.regions === undefined || (Array.isArray(card.regions) && card.regions.every(isNonEmptyString))) &&
    Number.isFinite(card.weight) &&
    typeof card.published === 'boolean' &&
    card.text !== null && typeof card.text === 'object' &&
    isValidExploreText(card.text.en) &&
    Object.values(card.text).every(isValidExploreText)
  );
}

function putExploreCardText(cardId, text) {
  for (const key of exploreCardText.keys()) {
    if (key.startsWith(`${cardId}::`)) exploreCardText.delete(key);
  }
  for (const [locale, value] of Object.entries(text)) {
    exploreCardText.set(`${cardId}::${locale}`, value);
  }
}

function loadExploreSeed() {
  try {
    const raw = fs.readFileSync(EXPLORE_SEED_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.cards) || !parsed.cards.every(isValidExploreCardShape)) {
      throw new Error('missing required fields or wrong types');
    }
    const now = Date.now();
    for (const card of parsed.cards) {
      exploreCards.set(card.id, {
        id: card.id,
        type: card.type,
        category: card.category,
        imageUrl: card.imageUrl ?? null,
        imageHeight: card.imageHeight,
        icon: card.icon,
        targetUrl: card.targetUrl ?? null,
        navigateTo: card.navigateTo ?? null,
        minAppVersion: card.minAppVersion,
        regions: card.regions ?? null,
        weight: card.weight,
        published: card.published,
        publishAt: card.publishAt ?? null,
        expiresAt: card.expiresAt ?? null,
        createdAtMs: now,
        updatedAtMs: now,
      });
      putExploreCardText(card.id, card.text);
    }
    console.log(`[explore] loaded explore-seed.json — ${parsed.cards.length} card(s)`);
  } catch (err) {
    // Never brick the Explore tab over a bad seed file — same fallback philosophy as
    // src/routes/config.js's PERMISSIVE_FALLBACK, just applied to "serve nothing" here since
    // there's no safe default card content to invent (unlike config.js's all-features-on
    // default, a fabricated card would violate the no-invented-content rule this feed exists to
    // enforce).
    console.error(`[explore] FAILED to load explore-seed.json (${err.message}) — serving an empty Explore feed instead.`);
  }
}

loadExploreSeed();

function resolveExploreText(cardId, locale) {
  return exploreCardText.get(`${cardId}::${locale}`) || exploreCardText.get(`${cardId}::en`) || null;
}

// Every locale a card has text for, keyed by locale — unlike resolveExploreText (one locale,
// with fallback), this is what an admin listing/edit view needs to show every translation at
// once.
function allExploreTextFor(cardId) {
  const text = {};
  const prefix = `${cardId}::`;
  for (const [key, value] of exploreCardText.entries()) {
    if (key.startsWith(prefix)) text[key.slice(prefix.length)] = value;
  }
  return text;
}

// Unfiltered — every card regardless of published/window/region/version, for
// GET /v1/admin/explore-cards. GET /v1/content/explore (the public feed) uses listExploreCards
// below instead, which applies all of that eligibility filtering.
async function listAllExploreCards() {
  return [...exploreCards.values()]
    .sort((a, b) => (b.weight - a.weight) || (b.createdAtMs - a.createdAtMs))
    .map((card) => ({ ...card, text: allExploreTextFor(card.id) }));
}

// Unfiltered single-card lookup by id — used by GET /r/:cardId (a card must redirect even if it
// has since been unpublished or expired; the link was valid when it was shown) and by the admin
// API's DELETE/PUT existence checks.
async function getExploreCard(id) {
  const card = exploreCards.get(id);
  if (!card) return null;
  return { ...card, text: allExploreTextFor(id) };
}

async function listExploreCards({ locale = 'en', region = null, appVersion = null, now = new Date() } = {}) {
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  const eligible = [...exploreCards.values()].filter((card) => {
    if (!card.published) return false;
    if (card.publishAt && new Date(card.publishAt).getTime() > nowMs) return false;
    if (card.expiresAt && new Date(card.expiresAt).getTime() <= nowMs) return false;
    // regions === null means "everywhere". Otherwise the caller's region must be present AND
    // must actually match one of the card's regions — an absent/unknown caller region never
    // matches a region-restricted card (see src/routes/content.js's header comment).
    if (card.regions && (!region || !card.regions.includes(region))) return false;
    // A caller version that can't be parsed (null, missing header, garbage) fails OPEN — same
    // convention compareVersions' every other caller in this repo already follows.
    if (compareVersions(appVersion, card.minAppVersion) === -1) return false;
    return true;
  });
  eligible.sort((a, b) => (b.weight - a.weight) || (b.createdAtMs - a.createdAtMs));
  return eligible.map((card) => ({ ...card, text: resolveExploreText(card.id, locale) }));
}

async function upsertExploreCard(card) {
  const existing = exploreCards.get(card.id);
  const now = Date.now();
  const stored = {
    id: card.id,
    type: card.type,
    category: card.category,
    imageUrl: card.imageUrl ?? null,
    imageHeight: card.imageHeight,
    icon: card.icon,
    targetUrl: card.targetUrl ?? null,
    navigateTo: card.navigateTo ?? null,
    minAppVersion: card.minAppVersion,
    regions: card.regions ?? null,
    weight: card.weight,
    published: card.published,
    publishAt: card.publishAt ?? null,
    expiresAt: card.expiresAt ?? null,
    createdAtMs: existing ? existing.createdAtMs : now,
    updatedAtMs: now,
  };
  exploreCards.set(card.id, stored);
  putExploreCardText(card.id, card.text || {});
  return { ...stored, text: card.text };
}

async function deleteExploreCard(id) {
  const existed = exploreCards.delete(id);
  for (const key of exploreCardText.keys()) {
    if (key.startsWith(`${id}::`)) exploreCardText.delete(key);
  }
  return existed;
}

async function recordExploreClick({ cardId, region, appVersion }) {
  exploreClicks.push({
    id: exploreClickSeq,
    cardId,
    clickedAt: new Date(),
    region: region ?? null,
    appVersion: appVersion ?? null,
  });
  exploreClickSeq += 1;
}

async function exploreClickCounts({ since }) {
  const cutoffMs = (since instanceof Date ? since : new Date(since)).getTime();
  const counts = new Map();
  for (const click of exploreClicks) {
    if (click.clickedAt.getTime() < cutoffMs) continue;
    counts.set(click.cardId, (counts.get(click.cardId) || 0) + 1);
  }
  return [...counts.entries()].map(([cardId, clicks]) => ({ cardId, clicks }));
}

// ---------------------------------------------------------------------------
// Home banner carousel — GET /v1/content/home-banners, GET /r/banner/:id,
// POST /v1/content/home-banners/impressions, /v1/admin/home-banners. Same layout as the Explore
// maps above (rows without text; text keyed "<bannerId>::<locale>"; a flat click log), plus a
// daily impressions map. One deliberate difference: nothing is loaded at boot. Banners come only
// from the admin API or scripts/seed-home-banners.js, so a deploy never writes banner content.
// ---------------------------------------------------------------------------

const homeBanners = new Map(); // id -> banner fields (no `text`)
const homeBannerText = new Map(); // "<bannerId>::<locale>" -> { title, subtitle, ctaLabel, altText, imageUrl }
let homeBannerClicks = []; // { id, bannerId, clickedAt: Date, region, appVersion }
let homeBannerClickSeq = 1;
const homeBannerImpressions = new Map(); // "<bannerId>::<YYYY-MM-DD>" -> count

function toBannerText(value) {
  return {
    title: value.title ?? null,
    subtitle: value.subtitle ?? null,
    ctaLabel: value.ctaLabel ?? null,
    altText: value.altText,
    imageUrl: value.imageUrl ?? null,
  };
}

function putHomeBannerText(bannerId, text) {
  for (const key of homeBannerText.keys()) {
    if (key.startsWith(`${bannerId}::`)) homeBannerText.delete(key);
  }
  for (const [locale, value] of Object.entries(text)) {
    homeBannerText.set(`${bannerId}::${locale}`, toBannerText(value));
  }
}

function allHomeBannerTextFor(bannerId) {
  const text = {};
  const prefix = `${bannerId}::`;
  for (const [key, value] of homeBannerText.entries()) {
    if (key.startsWith(prefix)) text[key.slice(prefix.length)] = value;
  }
  return text;
}

// Unfiltered, for GET /v1/admin/home-banners.
async function listAllHomeBanners() {
  return [...homeBanners.values()].sort(bannerOrder).map((banner) => ({ ...banner, text: allHomeBannerTextFor(banner.id) }));
}

// Unfiltered single lookup — GET /r/banner/:id must still redirect for a banner that has since
// been deactivated (the link was valid when it was shown), same as getExploreCard.
async function getHomeBanner(id) {
  const banner = homeBanners.get(id);
  if (!banner) return null;
  return { ...banner, text: allHomeBannerTextFor(id) };
}

// The public carousel: active, inside its window, shown in this language (locales NULL = every
// language), new enough app, in position order, at most `limit`. `text` is the requested locale's
// row, else "en"; a banner with neither is dropped.
async function listHomeBanners({ locale = 'en', appVersion = null, now = new Date(), limit = 10 } = {}) {
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  const eligible = [...homeBanners.values()].filter((banner) => {
    if (!banner.active) return false;
    if (banner.startsAt && new Date(banner.startsAt).getTime() > nowMs) return false;
    if (banner.endsAt && new Date(banner.endsAt).getTime() <= nowMs) return false;
    if (banner.locales && !banner.locales.includes(locale)) return false;
    // A null minAppVersion, or a caller version that can't be parsed, fails OPEN.
    if (compareVersions(appVersion, banner.minAppVersion) === -1) return false;
    return true;
  });
  eligible.sort(bannerOrder);
  const result = [];
  for (const banner of eligible) {
    const text = homeBannerText.get(`${banner.id}::${locale}`) || homeBannerText.get(`${banner.id}::en`) || null;
    if (!text) continue;
    result.push({ ...banner, text });
    if (result.length >= limit) break;
  }
  return result;
}

async function upsertHomeBanner(banner) {
  const existing = homeBanners.get(banner.id);
  const now = Date.now();
  const stored = {
    id: banner.id,
    type: banner.type,
    partnerName: banner.partnerName ?? null,
    position: banner.position,
    active: banner.active,
    startsAt: banner.startsAt ?? null,
    endsAt: banner.endsAt ?? null,
    minAppVersion: banner.minAppVersion ?? null,
    imageUrl: banner.imageUrl,
    imageHasText: banner.imageHasText ?? false,
    textTheme: banner.textTheme ?? 'light',
    targetUrl: banner.targetUrl ?? null,
    navigateTo: banner.navigateTo ?? null,
    requiresUpcomingTrip: banner.requiresUpcomingTrip ?? false,
    locales: banner.locales ?? null,
    createdAtMs: existing ? existing.createdAtMs : now,
    updatedAtMs: now,
  };
  homeBanners.set(banner.id, stored);
  putHomeBannerText(banner.id, banner.text || {});
  return { ...stored, text: allHomeBannerTextFor(banner.id) };
}

async function deleteHomeBanner(id) {
  const existed = homeBanners.delete(id);
  for (const key of homeBannerText.keys()) {
    if (key.startsWith(`${id}::`)) homeBannerText.delete(key);
  }
  return existed;
}

async function recordHomeBannerClick({ bannerId, region, appVersion }) {
  homeBannerClicks.push({
    id: homeBannerClickSeq,
    bannerId,
    clickedAt: new Date(),
    region: region ?? null,
    appVersion: appVersion ?? null,
  });
  homeBannerClickSeq += 1;
}

// counts: { bannerId: n } (already validated by the route). Ids that are not a banner are
// skipped. Returns how many banners were counted.
async function recordHomeBannerImpressions({ counts, day }) {
  let recorded = 0;
  for (const [bannerId, n] of Object.entries(counts)) {
    if (!homeBanners.has(bannerId)) continue;
    const key = `${bannerId}::${day}`;
    homeBannerImpressions.set(key, (homeBannerImpressions.get(key) || 0) + n);
    recorded += 1;
  }
  return recorded;
}

// Impressions and clicks per banner for the UTC days fromDay..toDay (YYYY-MM-DD, inclusive).
async function homeBannerStats({ fromDay, toDay }) {
  const stats = new Map();
  const row = (id) => {
    if (!stats.has(id)) stats.set(id, { bannerId: id, impressions: 0, clicks: 0 });
    return stats.get(id);
  };
  for (const [key, n] of homeBannerImpressions.entries()) {
    const [bannerId, day] = key.split('::');
    if (day >= fromDay && day <= toDay) row(bannerId).impressions += n;
  }
  const fromMs = Date.parse(`${fromDay}T00:00:00Z`);
  const toMs = Date.parse(`${toDay}T00:00:00Z`) + 24 * 60 * 60 * 1000;
  for (const click of homeBannerClicks) {
    const t = click.clickedAt.getTime();
    if (t >= fromMs && t < toMs) row(click.bannerId).clicks += 1;
  }
  return [...stats.values()];
}

// Test-only reset so scripts/test-ai-credits.js and scripts/test-ai-brief.js can start each
// scenario from a clean store, the same way scripts/test-ai-run.js already resets
// providerGateway's circuit breaker between cases. Production code never calls this.
function _resetForTests() {
  runs.clear();
  idempotencyIndex.clear();
  ledger = [];
  entitlements.clear();
  briefs.clear();
  exploreClicks = [];
  homeBanners.clear();
  homeBannerText.clear();
  homeBannerClicks = [];
  homeBannerImpressions.clear();
}

module.exports = {
  saveRun,
  getRun,
  findByIdempotency,
  listRuns,
  recordCredit,
  creditsUsed,
  globalSpendToday,
  saveEntitlement,
  getEntitlement,
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
  _resetForTests,
};
