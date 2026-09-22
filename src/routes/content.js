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
// ============================================================================

const crypto = require('crypto');
const express = require('express');

const store = require('../lib/store');

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
    actionURL: card.type === 'affiliate' ? `${baseUrl}/r/${encodeURIComponent(card.id)}` : null,
    navigateTo: card.type === 'firstParty' ? card.navigateTo : null,
  };
}

const router = express.Router();

router.get('/explore', async (req, res) => {
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
    res.status(200).json({ version: EXPLORE_CONTENT_VERSION, ttlSeconds, cards: [] });
  }
});

module.exports = router;
