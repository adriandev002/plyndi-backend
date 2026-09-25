// ============================================================================
// GET /v1/content/explore — Phase 2 server-driven Explore feed content.
// ----------------------------------------------------------------------------
// Replaces ExploreView.swift's `staticFeedItems` Phase-0 stopgap array — see that file's own
// header comment ("do not grow this list by hand ... the feed moves to /v1/content/explore in
// Phase 2"). This route is read-only; the admin API (src/routes/admin.js) is what writes cards.
//
// Card contract:
//   id, type ("editorial" | "affiliate" | "firstParty"), category ("travel" | "hotels" |
//   "lifestyle"), imageUrl, imageHeight, icon, tag, title, description, ctaLabel, actionURL,
//   navigateTo
//
// An "affiliate" card's actionURL always points at this server's own /r/<id> redirect, NEVER at
// the partner URL directly — the app never sees, and can't leak or hardcode, a raw affiliate
// link. A "firstParty" card carries navigateTo (an opaque destination id the app's own
// AppDestination enum resolves) instead, and never both.
//
// Filtering (all done by src/lib/store/{memory,postgres}Store.js's listExploreCards, not here):
//   - published + inside its publish/expire window
//   - region: NULL on the card = everywhere; otherwise the caller's ?region= must be present and
//     match one of the card's regions. An absent/unknown caller region only ever matches a
//     regions:NULL card — same "can't prove eligible -> exclude, can't prove ineligible ->
//     include" split compareVersions already draws for versions below.
//   - min_app_version via src/lib/semver.js's compareVersions against X-Plyndi-App-Version. A
//     null/unparseable caller version FAILS OPEN (the card is included) — same convention
//     src/routes/config.js's version gate and src/routes/aiHub.js's capability visibility both
//     already use: a header a build forgot to send must never look like "too old".
//   - locale: an unrecognized ?locale= (or one a specific card has no translation for) falls back
//     to "en" per card, inside the store layer.
//
// On ANY internal failure this returns 200 with `cards: []` and a real ttlSeconds, never a 500 —
// an Explore tab with no cards degrades gracefully; one that 500s looks like the app is broken.
// That failure answer is marked `X-Plyndi-Content-Degraded: 1` (see `sendDegraded` below) so the
// app can tell it apart from a real empty feed and keep its cache.
//
// Both content GETs have their own per-IP limiter (`contentLimiter`) and are mounted in
// src/server.js AHEAD of the general 60-an-hour limiter that guards the paid AI routes: on a
// mobile carrier many users share one IP, and every app foreground fetches both.
// ============================================================================

const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');

const store = require('../lib/store');
const homeBannerSettings = require('../lib/homeBanners');

// Bumped only on a breaking change to the card contract above (a field renamed or removed) — not
// on ordinary content edits, which admins make through the store directly. Same role
// remote-config.json's configVersion and hub.json's hubVersion play for their own payloads.
const EXPLORE_CONTENT_VERSION = 1;
const DEFAULT_TTL_SECONDS = 900;

function publicBaseUrl(req) {
  const configured = String(process.env.PUBLIC_BASE_URL || '').trim();
  if (configured) return configured.replace(/\/+$/, '');
  // No PUBLIC_BASE_URL configured (e.g. local dev) — derive one from the request itself rather
  // than fail. Render always sits behind a proxy that sets these correctly (see server.js's
  // `trust proxy` setting), so this is the real public URL there too, not just a dev fallback.
  return `${req.protocol}://${req.get('host')}`;
}

function readLocale(req) {
  const value = req.query.locale;
  return typeof value === 'string' && value.trim() ? value.trim() : 'en';
}

function readRegion(req) {
  const value = req.query.region;
  return typeof value === 'string' && value.trim() ? value.trim().toUpperCase() : null;
}

function toResponseCard(card, baseUrl) {
  if (!card.text) return null; // defensive — listExploreCards should never hand back textless cards
  return {
    id: card.id,
    type: card.type,
    category: card.category,
    imageUrl: card.imageUrl,
    imageHeight: card.imageHeight,
    icon: card.icon,
    tag: card.text.tag,
    title: card.text.title,
    description: card.text.description,
    ctaLabel: card.text.ctaLabel,
    // Editorial cards (a plyndi.com guide, say) link out through /r/<id> exactly like affiliate
    // cards: one code path, and the same click counts in the admin page. Until 25 Sep 2026 only
    // affiliate cards got an actionURL, so an editorial card reached the app with neither an
    // actionURL nor a navigateTo, and the iOS client — which drops any card with no action —
    // silently discarded every one of them.
    actionURL: (card.type === 'affiliate' || card.type === 'editorial')
      ? `${baseUrl}/r/${encodeURIComponent(card.id)}`
      : null,
    navigateTo: card.type === 'firstParty' ? card.navigateTo : null,
  };
}

// Generous on purpose: this is read-only, cache-friendly content, and one carrier IP can front
// thousands of phones. Every request counts, a cheap 304 included.
const contentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.CONTENT_RATE_LIMIT_MAX) || 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' },
});

// The error path's "200 with an empty list". Marked degraded so the app keeps what it already
// has instead of treating an internal failure as "the admin switched everything off"; no-store
// so no cache in between keeps it; and NO ETag — res.end() rather than res.json() because
// Express would otherwise attach its own weak ETag, and the app would send that back as
// If-None-Match and get a 304 for the failure itself.
function sendDegraded(res, body) {
  res.removeHeader('ETag');
  res.set('X-Plyndi-Content-Degraded', '1');
  res.set('Cache-Control', 'no-store');
  res.status(200).type('application/json').end(JSON.stringify(body));
}

const router = express.Router();

router.get('/explore', contentLimiter, async (req, res) => {
  const ttlSeconds = Number(process.env.CONTENT_TTL_SECONDS) || DEFAULT_TTL_SECONDS;
  try {
    const locale = readLocale(req);
    const region = readRegion(req);
    const appVersion = req.appContext ? req.appContext.appVersion : null;
    const baseUrl = publicBaseUrl(req);

    const cards = await store.listExploreCards({ locale, region, appVersion, now: new Date() });
    const body = {
      version: EXPLORE_CONTENT_VERSION,
      ttlSeconds,
      cards: cards.map((card) => toResponseCard(card, baseUrl)).filter(Boolean),
    };

    const etag = `"${crypto.createHash('sha1').update(JSON.stringify(body)).digest('hex')}"`;
    res.set('ETag', etag);
    res.set('Cache-Control', `max-age=${ttlSeconds}`);

    if (req.get('If-None-Match') === etag) {
      res.status(304).end();
      return;
    }

    res.status(200).json(body);
  } catch (err) {
    console.error(`[content] GET /v1/content/explore failed: ${err.message}`);
    sendDegraded(res, { version: EXPLORE_CONTENT_VERSION, ttlSeconds, cards: [] });
  }
});

// ============================================================================
// GET /v1/content/home-banners — the Home screen banner carousel.
// ----------------------------------------------------------------------------
// Same client key, ETag/304, locale fallback, fail-open min version and "200 with an empty list,
// never a 500" behaviour as /explore above. Banner contract (same spellings as an Explore card —
// imageUrl, actionURL):
//   id, type ("firstParty" | "affiliate"), partnerName, imageUrl, imageHasText, textTheme,
//   title, subtitle, ctaLabel, altText, actionURL, navigateTo, requiresUpcomingTrip
//
// imageHasText: the words are drawn into the image, so title/subtitle/ctaLabel are null and
// imageUrl is this locale's own image if it has one, else the banner's default image.
//
// A banner with a target URL gets actionURL = this server's own /r/banner/<id>, never the
// partner URL — the /r/banner/ prefix keeps it from colliding with an Explore card's /r/<id> when
// the two share an id. A banner with a navigateTo gets that instead; one with neither is shown
// but not tappable. The admin API guarantees never both.
//
// requiresUpcomingTrip is passed through for the APP to apply: only it knows whether this user
// has a trip planned, and that must not be sent here.
// ============================================================================

function toResponseBanner(banner, baseUrl) {
  const text = banner.text;
  if (!text || !text.altText) return null; // defensive — the store drops these already
  const hasText = banner.imageHasText === true;
  return {
    id: banner.id,
    type: banner.type,
    partnerName: banner.partnerName || null,
    imageUrl: hasText ? (text.imageUrl || banner.imageUrl) : banner.imageUrl,
    imageHasText: hasText,
    textTheme: banner.textTheme || 'light',
    title: hasText ? null : (text.title || null),
    subtitle: hasText ? null : (text.subtitle || null),
    ctaLabel: hasText ? null : (text.ctaLabel || null),
    altText: text.altText,
    actionURL: banner.targetUrl ? `${baseUrl}/r/banner/${encodeURIComponent(banner.id)}` : null,
    navigateTo: banner.targetUrl ? null : (banner.navigateTo || null),
    requiresUpcomingTrip: banner.requiresUpcomingTrip === true,
  };
}

router.get('/home-banners', contentLimiter, async (req, res) => {
  const ttlSeconds = Number(process.env.CONTENT_TTL_SECONDS) || DEFAULT_TTL_SECONDS;
  const intervalSeconds = homeBannerSettings.intervalSeconds();
  const aspectRatio = homeBannerSettings.aspectRatio();
  try {
    const locale = readLocale(req);
    const appVersion = req.appContext ? req.appContext.appVersion : null;
    const baseUrl = publicBaseUrl(req);

    const banners = await store.listHomeBanners({
      locale,
      appVersion,
      now: new Date(),
      limit: homeBannerSettings.MAX_ACTIVE_BANNERS,
    });
    const body = {
      intervalSeconds,
      aspectRatio,
      banners: banners.map((banner) => toResponseBanner(banner, baseUrl)).filter(Boolean),
    };

    const etag = `"${crypto.createHash('sha1').update(JSON.stringify(body)).digest('hex')}"`;
    res.set('ETag', etag);
    res.set('Cache-Control', `max-age=${ttlSeconds}`);

    if (req.get('If-None-Match') === etag) {
      res.status(304).end();
      return;
    }

    res.status(200).json(body);
  } catch (err) {
    console.error(`[content] GET /v1/content/home-banners failed: ${err.message}`);
    sendDegraded(res, { intervalSeconds, aspectRatio, banners: [] });
  }
});

// ============================================================================
// POST /v1/content/home-banners/impressions — aggregated daily view counts from the app.
// ----------------------------------------------------------------------------
// Body: { "counts": { "<bannerId>": <whole number 1-50>, ... } }, at most 10 entries. Each count
// is ADDED to that banner's row for today (UTC). Ids that are not a banner are skipped.
//
// ALWAYS 204. The app fires this and forgets it; nothing it could learn from a 4xx would change
// what it does next, and a bad body must never become a 500. A body that breaks any rule is
// dropped whole (nothing stored) rather than partly applied. Rate-limited requests are dropped
// the same way — 204, not 429, so no client ever retries into the limit. (A malformed JSON body
// never reaches this handler at all: src/server.js turns express.json()'s parse error into a
// 204 for this path.)
//
// Mounted by src/server.js AFTER requireClientKey but BEFORE the general per-IP limiter, the
// same placement /v1/config has: impression pings must not spend the 60-an-hour budget that
// guards the paid AI routes.
//
// Stores counts only — no user id, device id or IP, here or in the table.
// ============================================================================

const MAX_IMPRESSION_ENTRIES = 10;
const MAX_IMPRESSIONS_PER_ENTRY = 50;
const BANNER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

const impressionsLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: Number(process.env.HOME_BANNER_IMPRESSIONS_RATE_LIMIT_MAX) || 30,
  standardHeaders: false,
  legacyHeaders: false,
  handler: (_req, res) => res.status(204).end(),
});

// Returns a plain { id: n } object, or null if the body breaks any rule.
function readImpressionCounts(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const counts = body.counts;
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)) return null;
  const entries = Object.entries(counts);
  if (entries.length === 0 || entries.length > MAX_IMPRESSION_ENTRIES) return null;
  const clean = {};
  for (const [id, n] of entries) {
    if (!BANNER_ID_PATTERN.test(id)) return null;
    if (!Number.isInteger(n) || n < 1 || n > MAX_IMPRESSIONS_PER_ENTRY) return null;
    clean[id] = n;
  }
  return clean;
}

const impressionsRouter = express.Router();

impressionsRouter.post('/', impressionsLimiter, async (req, res) => {
  try {
    const counts = readImpressionCounts(req.body);
    if (counts) await store.recordHomeBannerImpressions({ counts, day: homeBannerSettings.utcDay() });
  } catch (err) {
    console.error(`[content] POST /v1/content/home-banners/impressions failed (answering 204 anyway): ${err.message}`);
  }
  res.status(204).end();
});

module.exports = router;
module.exports.homeBannerImpressionsRouter = impressionsRouter;
