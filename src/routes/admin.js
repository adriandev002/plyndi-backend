// ============================================================================
// /v1/admin/explore-cards, /v1/admin/explore-clicks — Phase 2 admin API for the Explore feed.
// ----------------------------------------------------------------------------
// Writes what GET /v1/content/explore reads (src/lib/store's listExploreCards/upsertExploreCard/
// deleteExploreCard/exploreClickCounts). There is no admin HTML anywhere in this repo — the admin
// UI is a separate Cloudflare Pages app (Phase 3) that talks to this API directly, which is why
// this is guarded by its own ADMIN_TOKEN rather than CLIENT_SHARED_KEY: that app has no reason to
// carry the mobile client's shared secret, and the mobile client has no reason to ever see
// ADMIN_TOKEN.
//
// ADMIN_TOKEN unset -> every route below returns 503, never a 200 with no auth. An admin API that
// quietly no-ops its own gate the moment an env var is forgotten is worse than one that refuses
// to come up at all — same "fail closed, loudly" posture requireClientKey already takes for
// CLIENT_SHARED_KEY (src/middleware/auth.js).
// ============================================================================

const crypto = require('crypto');
const express = require('express');

const store = require('../lib/store');
const { NAVIGATE_DESTINATIONS, isValidNavigateTo } = require('../lib/exploreDestinations');

const CARD_TYPES = new Set(['editorial', 'affiliate', 'firstParty']);
const CARD_CATEGORIES = new Set(['travel', 'hotels', 'lifestyle']);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const ALLOWED_CARD_FIELDS = new Set([
  'id', 'type', 'category', 'imageUrl', 'imageHeight', 'icon', 'targetUrl', 'navigateTo',
  'minAppVersion', 'regions', 'weight', 'published', 'publishAt', 'expiresAt', 'text',
]);
const ALLOWED_TEXT_FIELDS = new Set(['tag', 'title', 'description', 'ctaLabel']);
const DEFAULT_CLICKS_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function unknownFields(obj, allowed) {
  if (!obj || typeof obj !== 'object') return [];
  return Object.keys(obj).filter((key) => !allowed.has(key));
}

// Fills in the same defaults db/schema.sql declares (image_height 160, min_app_version '0.0.0',
// weight 0, published false) so a minimal admin payload behaves identically to a row inserted any
// other way, then validates the result. Mutates `body` in place — the caller passes the parsed
// request body, which is only ever used once.
function validateCardPayload(body) {
  const errors = [];
  const extra = unknownFields(body, ALLOWED_CARD_FIELDS);
  if (extra.length) errors.push(`unknown field(s): ${extra.join(', ')}`);

  if (!isNonEmptyString(body.id) || !ID_PATTERN.test(body.id)) {
    errors.push('"id" must be a non-empty string of letters, digits, "_" or "-" (it becomes part of the /r/:id redirect URL)');
  }
  if (!CARD_TYPES.has(body.type)) errors.push(`"type" must be one of ${[...CARD_TYPES].join(', ')}`);
  if (!CARD_CATEGORIES.has(body.category)) errors.push(`"category" must be one of ${[...CARD_CATEGORIES].join(', ')}`);

  if (body.imageUrl !== undefined && body.imageUrl !== null && !isNonEmptyString(body.imageUrl)) {
    errors.push('"imageUrl" must be null or a non-empty string');
  }
  if (body.imageHeight === undefined) body.imageHeight = 160;
  if (!Number.isFinite(body.imageHeight)) errors.push('"imageHeight" must be a number');

  if (!isNonEmptyString(body.icon)) errors.push('"icon" must be a non-empty string');

  if (body.targetUrl !== undefined && body.targetUrl !== null && !isNonEmptyString(body.targetUrl)) {
    errors.push('"targetUrl" must be null or a non-empty string');
  }
  // Validated against the real client destinations, not just "is a string" — see
  // lib/exploreDestinations.js for why a typo here would silently delete the card client-side.
  if (body.navigateTo !== undefined && body.navigateTo !== null && !isValidNavigateTo(body.navigateTo)) {
    errors.push(`"navigateTo" must be null or one of: ${[...NAVIGATE_DESTINATIONS].join(', ')}`);
  }
  if (body.type === 'firstParty' && (body.navigateTo === undefined || body.navigateTo === null)) {
    errors.push('a "firstParty" card must carry a "navigateTo" — it has no URL to fall back on');
  }
  if (body.type === 'affiliate' && !isNonEmptyString(body.targetUrl)) {
    errors.push('an "affiliate" card must carry a "targetUrl" — /r/:id has nowhere to redirect without one');
  }
  // NO price/rating/badge/discount field is even in ALLOWED_CARD_FIELDS above — a payload trying
  // to add one is rejected by the unknown-field check, not by a rule here. See db/schema.sql's
  // header comment on explore_cards for why that omission is deliberate.

  if (body.minAppVersion === undefined) body.minAppVersion = '0.0.0';
  if (!isNonEmptyString(body.minAppVersion)) errors.push('"minAppVersion" must be a non-empty string');

  if (body.regions !== undefined && body.regions !== null) {
    if (!Array.isArray(body.regions) || !body.regions.every(isNonEmptyString)) {
      errors.push('"regions" must be null (everywhere) or an array of non-empty strings');
    }
  }

  if (body.weight === undefined) body.weight = 0;
  if (!Number.isFinite(body.weight)) errors.push('"weight" must be a number');

  if (body.published === undefined) body.published = false;
  if (typeof body.published !== 'boolean') errors.push('"published" must be a boolean');

  if (body.publishAt !== undefined && body.publishAt !== null && Number.isNaN(Date.parse(body.publishAt))) {
    errors.push('"publishAt" must be null or an ISO date string');
  }
  if (body.expiresAt !== undefined && body.expiresAt !== null && Number.isNaN(Date.parse(body.expiresAt))) {
    errors.push('"expiresAt" must be null or an ISO date string');
  }

  if (!body.text || typeof body.text !== 'object' || Array.isArray(body.text)) {
    errors.push('"text" must be an object keyed by locale, e.g. { "en": { tag, title, description, ctaLabel } }');
  } else {
    if (!body.text.en) errors.push('"text.en" is required — every other locale falls back to it (see src/lib/store)');
    for (const [locale, value] of Object.entries(body.text)) {
      const textExtra = unknownFields(value, ALLOWED_TEXT_FIELDS);
      if (textExtra.length) errors.push(`text.${locale}: unknown field(s): ${textExtra.join(', ')}`);
      const hasAllFields = value && typeof value === 'object'
        && isNonEmptyString(value.tag) && isNonEmptyString(value.title)
        && isNonEmptyString(value.description) && isNonEmptyString(value.ctaLabel);
      if (!hasAllFields) errors.push(`text.${locale} must have non-empty tag/title/description/ctaLabel`);
    }
  }

  return errors;
}

function requireAdminToken(req, res, next) {
  const expected = String(process.env.ADMIN_TOKEN || '');
  if (!expected) {
    console.error('[admin] ADMIN_TOKEN is not set — refusing all /v1/admin requests.');
    res.status(503).json({ error: 'Admin API is not configured.' });
    return;
  }
  const provided = String(req.get('X-Admin-Token') || '');
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);
  const matches = providedBuf.length === expectedBuf.length && crypto.timingSafeEqual(providedBuf, expectedBuf);
  if (!matches) {
    res.status(401).json({ error: 'Missing or invalid admin token.' });
    return;
  }
  next();
}

const router = express.Router();
router.use(requireAdminToken);

router.get('/explore-cards', async (_req, res) => {
  try {
    const cards = await store.listAllExploreCards();
    res.status(200).json({ cards });
  } catch (err) {
    console.error(`[admin] GET /v1/admin/explore-cards failed: ${err.message}`);
    res.status(500).json({ error: 'Failed to list explore cards.' });
  }
});

router.post('/explore-cards', async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const errors = validateCardPayload(body);
  if (errors.length) {
    res.status(400).json({ error: 'invalid_payload', details: errors });
    return;
  }
  try {
    const existing = await store.getExploreCard(body.id);
    if (existing) {
      res.status(409).json({ error: 'card_already_exists' });
      return;
    }
    const saved = await store.upsertExploreCard(body);
    res.status(201).json({ card: saved });
  } catch (err) {
    console.error(`[admin] POST /v1/admin/explore-cards failed: ${err.message}`);
    res.status(500).json({ error: 'Failed to create explore card.' });
  }
});

router.put('/explore-cards/:id', async (req, res) => {
  const incoming = req.body && typeof req.body === 'object' ? req.body : {};
  if (incoming.id !== undefined && incoming.id !== req.params.id) {
    res.status(400).json({ error: 'invalid_payload', details: ['body "id" does not match the URL path'] });
    return;
  }
  const body = Object.assign({}, incoming, { id: req.params.id });
  const errors = validateCardPayload(body);
  if (errors.length) {
    res.status(400).json({ error: 'invalid_payload', details: errors });
    return;
  }
  try {
    const saved = await store.upsertExploreCard(body);
    res.status(200).json({ card: saved });
  } catch (err) {
    console.error(`[admin] PUT /v1/admin/explore-cards/${req.params.id} failed: ${err.message}`);
    res.status(500).json({ error: 'Failed to save explore card.' });
  }
});

router.delete('/explore-cards/:id', async (req, res) => {
  try {
    const deleted = await store.deleteExploreCard(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.status(200).json({ deleted: true, id: req.params.id });
  } catch (err) {
    console.error(`[admin] DELETE /v1/admin/explore-cards/${req.params.id} failed: ${err.message}`);
    res.status(500).json({ error: 'Failed to delete explore card.' });
  }
});

router.get('/explore-clicks', async (req, res) => {
  const sinceParam = req.query.since;
  const since = isNonEmptyString(sinceParam) && !Number.isNaN(Date.parse(sinceParam))
    ? new Date(sinceParam)
    : new Date(Date.now() - DEFAULT_CLICKS_LOOKBACK_MS); // default: last 30 days
  try {
    const counts = await store.exploreClickCounts({ since });
    res.status(200).json({ since: since.toISOString(), counts });
  } catch (err) {
    console.error('[admin] GET /v1/admin/explore-clicks failed:', err.message);
    res.status(500).json({ error: 'Failed to load explore click counts.' });
  }
});

module.exports = router;
