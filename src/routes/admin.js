// ============================================================================
// /v1/admin/explore-cards, /v1/admin/explore-clicks — Phase 2 admin API for the Explore feed.
// /v1/admin/home-banners, /v1/admin/home-banner-stats, /v1/admin/translate — the Home carousel,
// same guard.
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
const rateLimit = require('express-rate-limit');

const store = require('../lib/store');
const { NAVIGATE_DESTINATIONS, isValidNavigateTo } = require('../lib/exploreDestinations');
const { APP_LOCALES, isAppLocale } = require('../lib/appLocales');
const homeBannerSettings = require('../lib/homeBanners');
const { parseVersion } = require('../lib/semver');
const providerGateway = require('../lib/providerGateway');

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
  if ((body.type === 'affiliate' || body.type === 'editorial') && !isNonEmptyString(body.targetUrl)) {
    errors.push(`an "${body.type}" card must carry a "targetUrl" — /r/:id has nowhere to redirect without one`);
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

// ---------------------------------------------------------------------------
// Home banners — /v1/admin/home-banners, /v1/admin/home-banner-stats, /v1/admin/translate.
// Same payload conventions as explore cards (camelCase, unknown fields rejected, defaults filled
// from db/schema.sql, `text` keyed by locale with "en" required), validated here so every failure
// is a readable 400.
// ---------------------------------------------------------------------------

const BANNER_TYPES = new Set(['firstParty', 'affiliate']);
const TEXT_THEMES = new Set(['light', 'dark']);
const ALLOWED_BANNER_FIELDS = new Set([
  'id', 'type', 'partnerName', 'position', 'active', 'startsAt', 'endsAt', 'minAppVersion',
  'imageUrl', 'imageHasText', 'textTheme', 'targetUrl', 'navigateTo', 'requiresUpcomingTrip',
  'locales', 'text',
]);
const ALLOWED_BANNER_TEXT_FIELDS = new Set(['title', 'subtitle', 'ctaLabel', 'altText', 'imageUrl']);
const { LIMITS, charCount } = homeBannerSettings;
// Not a separate rule — these are already unknown fields. Named so the 400 says WHY.
const OFFER_FIELD = /price|rating|badge|discount|deal/i;

function unknownBannerFieldError(fields, where) {
  const offers = fields.filter((key) => OFFER_FIELD.test(key));
  const reason = offers.length
    ? ' — Home banners never carry a price, rating, discount, badge or deal (see db/schema.sql\'s home_banners comment)'
    : '';
  return `${where}unknown field(s): ${fields.join(', ')}${reason}`;
}

function isHttpsUrl(value) {
  if (!isNonEmptyString(value)) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch (_err) {
    return false;
  }
}

// https:// AND an exact host from BANNER_IMAGE_HOSTS. Returns an error string or null.
function bannerImageUrlError(value, label) {
  const hosts = homeBannerSettings.imageHosts();
  let url;
  try {
    url = new URL(value);
  } catch (_err) {
    return `${label} must be a full https:// URL`;
  }
  if (url.protocol !== 'https:') return `${label} must be https://`;
  if (!hosts.includes(url.hostname.toLowerCase())) {
    return `${label} must be hosted on one of: ${hosts.join(', ')} (got ${url.hostname})`;
  }
  return null;
}

// Optional text: null/undefined, or a non-empty string of at most `max` characters.
function optionalTextError(value, label, max) {
  if (value === undefined || value === null) return null;
  if (!isNonEmptyString(value) || !value.trim()) return `${label} must be null or non-empty text`;
  const length = charCount(value.trim());
  if (length > max) return `${label} is ${length} characters; the limit is ${max}`;
  return null;
}

// Fills in db/schema.sql's defaults and validates. Mutates `body` in place, like
// validateCardPayload. The "at most 10 active" rule needs the store, so it lives in
// activeBannerLimitError below.
function validateBannerPayload(body) {
  const errors = [];
  const extra = unknownFields(body, ALLOWED_BANNER_FIELDS);
  if (extra.length) errors.push(unknownBannerFieldError(extra, ''));

  if (!isNonEmptyString(body.id) || !ID_PATTERN.test(body.id)) {
    errors.push('"id" must be a non-empty string of letters, digits, "_" or "-" (it becomes part of the /r/banner/:id redirect URL)');
  }
  if (!BANNER_TYPES.has(body.type)) errors.push(`"type" must be one of ${[...BANNER_TYPES].join(', ')}`);

  if (body.partnerName === undefined) body.partnerName = null;
  const partnerError = optionalTextError(body.partnerName, '"partnerName"', LIMITS.partnerName);
  if (partnerError) errors.push(partnerError);
  if (body.type === 'affiliate' && !isNonEmptyString(body.partnerName)) {
    errors.push('an "affiliate" banner must carry a "partnerName" — the app shows who the sponsor is');
  }

  if (body.position === undefined) body.position = 0;
  if (!Number.isInteger(body.position) || body.position < 0 || body.position > 9999) {
    errors.push('"position" must be a whole number from 0 to 9999 (lower shows first)');
  }
  for (const [key, fallback] of [['active', false], ['imageHasText', false], ['requiresUpcomingTrip', false]]) {
    if (body[key] === undefined) body[key] = fallback;
    if (typeof body[key] !== 'boolean') errors.push(`"${key}" must be a boolean`);
  }
  if (body.textTheme === undefined) body.textTheme = 'light';
  if (!TEXT_THEMES.has(body.textTheme)) errors.push('"textTheme" must be "light" (white text, dark scrim) or "dark" (dark text, light scrim)');

  for (const key of ['startsAt', 'endsAt']) {
    if (body[key] === undefined) body[key] = null;
    if (body[key] !== null && (typeof body[key] !== 'string' || Number.isNaN(Date.parse(body[key])))) {
      errors.push(`"${key}" must be null or an ISO date string`);
    }
  }
  if (typeof body.startsAt === 'string' && typeof body.endsAt === 'string'
      && Date.parse(body.endsAt) <= Date.parse(body.startsAt)) {
    errors.push('"endsAt" must be after "startsAt" — otherwise the banner is never shown');
  }

  // null = every version. A value that does not parse would make compareVersions fail OPEN and
  // show the banner to every build — the opposite of what setting it meant. (Stricter than the
  // brief asked; see the report.)
  if (body.minAppVersion === undefined) body.minAppVersion = null;
  if (body.minAppVersion !== null && (!isNonEmptyString(body.minAppVersion) || !parseVersion(body.minAppVersion))) {
    errors.push('"minAppVersion" must be null or a version like "1.4" or "1.4.2"');
  }

  if (!isNonEmptyString(body.imageUrl)) {
    errors.push('"imageUrl" is required — the banner\'s default image');
  } else {
    const imageError = bannerImageUrlError(body.imageUrl, '"imageUrl"');
    if (imageError) errors.push(imageError);
  }

  if (body.targetUrl === undefined) body.targetUrl = null;
  if (body.navigateTo === undefined) body.navigateTo = null;
  if (body.targetUrl !== null && !isHttpsUrl(body.targetUrl)) {
    errors.push('"targetUrl" must be null or a full https:// URL');
  }
  if (body.navigateTo !== null && !isValidNavigateTo(body.navigateTo)) {
    errors.push(`"navigateTo" must be null or one of: ${[...NAVIGATE_DESTINATIONS].join(', ')}`);
  }
  if (body.targetUrl !== null && body.navigateTo !== null) {
    errors.push('a banner has either "targetUrl" or "navigateTo" (or neither, for a banner that is not tappable) — never both');
  }
  if (body.type === 'affiliate' && !isNonEmptyString(body.targetUrl)) {
    errors.push('an "affiliate" banner must carry a "targetUrl" — /r/banner/:id has nowhere to redirect without one');
  }

  // null = every app language. An empty list would mean no language at all.
  if (body.locales === undefined) body.locales = null;
  if (body.locales !== null) {
    if (!Array.isArray(body.locales) || body.locales.length === 0) {
      errors.push('"locales" must be null (every language) or a non-empty list of app language codes');
    } else {
      const bad = body.locales.filter((locale) => !isAppLocale(locale));
      if (bad.length) errors.push(`"locales" has codes the app does not use: ${bad.join(', ')} (use: ${APP_LOCALES.join(', ')})`);
      if (new Set(body.locales).size !== body.locales.length) errors.push('"locales" lists a language twice');
    }
  }

  if (!body.text || typeof body.text !== 'object' || Array.isArray(body.text)) {
    errors.push('"text" must be an object keyed by locale, e.g. { "en": { title, altText } }');
  } else {
    if (!body.text.en) errors.push('"text.en" is required — every other locale falls back to it');
    for (const [locale, value] of Object.entries(body.text)) {
      const where = `text.${locale}`;
      if (!isAppLocale(locale)) {
        errors.push(`${where}: "${locale}" is not an app language (use: ${APP_LOCALES.join(', ')})`);
        continue;
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        errors.push(`${where} must be an object with at least altText`);
        continue;
      }
      const textExtra = unknownFields(value, ALLOWED_BANNER_TEXT_FIELDS);
      if (textExtra.length) errors.push(unknownBannerFieldError(textExtra, `${where}: `));

      const altLength = typeof value.altText === 'string' ? charCount(value.altText.trim()) : 0;
      if (altLength < 1 || altLength > LIMITS.altText) {
        errors.push(`${where}.altText must be 1–${LIMITS.altText} characters (it is what VoiceOver reads for the banner)`);
      }
      for (const [field, max] of [['title', LIMITS.title], ['subtitle', LIMITS.subtitle], ['ctaLabel', LIMITS.ctaLabel]]) {
        const fieldError = optionalTextError(value[field], `${where}.${field}`, max);
        if (fieldError) errors.push(fieldError);
      }
      // When the app draws the words, a row with no title would show an empty banner in that
      // language (fallback is per row, not per field) — so every row needs one, not just en.
      if (body.imageHasText === false && !isNonEmptyString(value.title)) {
        errors.push(`${where}.title is required when the image has no text of its own`);
      }
      if (value.imageUrl !== undefined && value.imageUrl !== null) {
        const overrideError = bannerImageUrlError(value.imageUrl, `${where}.imageUrl`);
        if (overrideError) errors.push(overrideError);
      }
    }
  }

  return errors;
}

async function activeBannerLimitError(body) {
  if (body.active !== true) return null;
  const all = await store.listAllHomeBanners();
  const otherActive = all.filter((banner) => banner.active && banner.id !== body.id).length;
  if (otherActive >= homeBannerSettings.MAX_ACTIVE_BANNERS) {
    return `at most ${homeBannerSettings.MAX_ACTIVE_BANNERS} banners can be active at once — deactivate one before activating "${body.id}"`;
  }
  return null;
}

async function currentBannerWarnings() {
  return homeBannerSettings.warningsFor(await store.listAllHomeBanners());
}

// What the admin page needs to preview and pre-validate against the same values the feed uses.
function bannerSettings() {
  return {
    intervalSeconds: homeBannerSettings.intervalSeconds(),
    aspectRatio: homeBannerSettings.aspectRatio(),
    imageHosts: homeBannerSettings.imageHosts(),
    maxActive: homeBannerSettings.MAX_ACTIVE_BANNERS,
    limits: LIMITS,
    locales: APP_LOCALES,
  };
}

// ---------- stats

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_STATS_DAYS = 366;

function isRealDay(value) {
  return typeof value === 'string' && DAY_PATTERN.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function addDays(day, n) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// ---------- translate

// A paid model call per request: its own ceiling, even behind ADMIN_TOKEN.
const translateLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: Number(process.env.ADMIN_TRANSLATE_RATE_LIMIT_MAX) || 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many translation requests. Try again in a few minutes.' },
});

const TRANSLATABLE_FIELDS = ['title', 'subtitle', 'ctaLabel', 'altText'];
const LOCALE_NAMES = {
  'zh-Hant': 'Traditional Chinese', 'zh-Hans': 'Simplified Chinese', ja: 'Japanese', ko: 'Korean',
  my: 'Burmese', th: 'Thai', vi: 'Vietnamese', ar: 'Arabic', es: 'Spanish', de: 'German', fr: 'French',
};

function translationPrompt(source, locales) {
  const fields = TRANSLATABLE_FIELDS.filter((field) => isNonEmptyString(source[field]));
  const limits = fields.map((field) => `${field} at most ${LIMITS[field]} characters`).join(', ');
  const system = [
    'You translate short marketing copy for a banner in Plyndi, a personal-organiser app (money, tasks, shopping and trips).',
    'Translate naturally for a phone screen: concise, friendly, not literal. Keep the brand name "Plyndi" and any other product or partner name exactly as written.',
    `Stay within these lengths, counting characters as a reader would: ${limits}. If a faithful translation cannot fit, shorten the wording — never cut a word in half.`,
    'altText is read aloud by a screen reader: describe the banner plainly.',
    'Do not add anything that is not in the English: no prices, discounts, ratings, badges, deals or claims.',
  ].join(' ');
  const user = JSON.stringify({
    source: Object.fromEntries(fields.map((field) => [field, source[field]])),
    targetLocales: locales.map((locale) => ({ locale, language: LOCALE_NAMES[locale] || locale })),
  });
  const itemProperties = { locale: { type: 'STRING', enum: locales } };
  for (const field of fields) itemProperties[field] = { type: 'STRING' };
  const jsonSchema = {
    type: 'OBJECT',
    properties: {
      translations: {
        type: 'ARRAY',
        items: { type: 'OBJECT', properties: itemProperties, required: ['locale', ...fields] },
      },
    },
    required: ['translations'],
  };
  return { fields, system, user, jsonSchema };
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

router.get('/home-banners', async (_req, res) => {
  try {
    const banners = await store.listAllHomeBanners();
    res.status(200).json({ banners, settings: bannerSettings(), warnings: homeBannerSettings.warningsFor(banners) });
  } catch (err) {
    console.error(`[admin] GET /v1/admin/home-banners failed: ${err.message}`);
    res.status(500).json({ error: 'Failed to list home banners.' });
  }
});

router.post('/home-banners', async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const errors = validateBannerPayload(body);
  if (errors.length) {
    res.status(400).json({ error: 'invalid_payload', details: errors });
    return;
  }
  try {
    const existing = await store.getHomeBanner(body.id);
    if (existing) {
      res.status(409).json({ error: 'banner_already_exists' });
      return;
    }
    const limitError = await activeBannerLimitError(body);
    if (limitError) {
      res.status(400).json({ error: 'invalid_payload', details: [limitError] });
      return;
    }
    const saved = await store.upsertHomeBanner(body);
    res.status(201).json({ banner: saved, warnings: await currentBannerWarnings() });
  } catch (err) {
    console.error(`[admin] POST /v1/admin/home-banners failed: ${err.message}`);
    res.status(500).json({ error: 'Failed to create home banner.' });
  }
});

router.put('/home-banners/:id', async (req, res) => {
  const incoming = req.body && typeof req.body === 'object' ? req.body : {};
  if (incoming.id !== undefined && incoming.id !== req.params.id) {
    res.status(400).json({ error: 'invalid_payload', details: ['body "id" does not match the URL path'] });
    return;
  }
  const body = Object.assign({}, incoming, { id: req.params.id });
  const errors = validateBannerPayload(body);
  if (errors.length) {
    res.status(400).json({ error: 'invalid_payload', details: errors });
    return;
  }
  try {
    const limitError = await activeBannerLimitError(body);
    if (limitError) {
      res.status(400).json({ error: 'invalid_payload', details: [limitError] });
      return;
    }
    const saved = await store.upsertHomeBanner(body);
    res.status(200).json({ banner: saved, warnings: await currentBannerWarnings() });
  } catch (err) {
    console.error(`[admin] PUT /v1/admin/home-banners/${req.params.id} failed: ${err.message}`);
    res.status(500).json({ error: 'Failed to save home banner.' });
  }
});

router.delete('/home-banners/:id', async (req, res) => {
  try {
    const deleted = await store.deleteHomeBanner(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.status(200).json({ deleted: true, id: req.params.id, warnings: await currentBannerWarnings() });
  } catch (err) {
    console.error(`[admin] DELETE /v1/admin/home-banners/${req.params.id} failed: ${err.message}`);
    res.status(500).json({ error: 'Failed to delete home banner.' });
  }
});

// GET /v1/admin/home-banner-stats?from=YYYY-MM-DD&to=YYYY-MM-DD — UTC days, both inclusive.
// Default: the last 30 days ending today. ctr = clicks / impressions, null with no impressions.
router.get('/home-banner-stats', async (req, res) => {
  const today = homeBannerSettings.utcDay();
  const to = req.query.to === undefined ? today : req.query.to;
  const from = req.query.from === undefined ? addDays(to, -29) : req.query.from;
  if (!isRealDay(from) || !isRealDay(to)) {
    res.status(400).json({ error: 'invalid_query', details: ['"from" and "to" must be dates like 2026-09-01'] });
    return;
  }
  if (from > to) {
    res.status(400).json({ error: 'invalid_query', details: ['"from" must not be after "to"'] });
    return;
  }
  if (addDays(from, MAX_STATS_DAYS - 1) < to) {
    res.status(400).json({ error: 'invalid_query', details: [`at most ${MAX_STATS_DAYS} days at a time`] });
    return;
  }
  try {
    const [rows, banners] = await Promise.all([
      store.homeBannerStats({ fromDay: from, toDay: to }),
      store.listAllHomeBanners(),
    ]);
    const byId = new Map(rows.map((row) => [row.bannerId, row]));
    for (const banner of banners) {
      if (!byId.has(banner.id)) byId.set(banner.id, { bannerId: banner.id, impressions: 0, clicks: 0 });
    }
    const stats = [...byId.values()].map((row) => ({
      ...row,
      ctr: row.impressions > 0 ? row.clicks / row.impressions : null,
    }));
    res.status(200).json({ from, to, stats });
  } catch (err) {
    console.error('[admin] GET /v1/admin/home-banner-stats failed:', err.message);
    res.status(500).json({ error: 'Failed to load home banner stats.' });
  }
});

// POST /v1/admin/translate — suggested translations of a banner's English copy, for a person to
// review in the admin page and then save. NEVER writes anything: it has no store call at all.
// Body: { "source": { title?, subtitle?, ctaLabel?, altText? }, "locales": ["ja", ...] }
// A translation over its length limit is returned as-is and flagged in `problems` — never
// truncated, because a clipped sentence is worse than one a person has to shorten.
router.post('/translate', translateLimiter, async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const errors = [];
  const extra = unknownFields(body, new Set(['source', 'locales']));
  if (extra.length) errors.push(`unknown field(s): ${extra.join(', ')}`);
  const source = body.source && typeof body.source === 'object' && !Array.isArray(body.source) ? body.source : null;
  if (!source) {
    errors.push('"source" must be an object with the English title, subtitle, ctaLabel and/or altText');
  } else {
    const sourceExtra = unknownFields(source, new Set(TRANSLATABLE_FIELDS));
    if (sourceExtra.length) errors.push(`source: unknown field(s): ${sourceExtra.join(', ')}`);
    if (!TRANSLATABLE_FIELDS.some((field) => isNonEmptyString(source[field]))) errors.push('"source" has nothing to translate');
    for (const field of TRANSLATABLE_FIELDS) {
      const fieldError = optionalTextError(source[field], `source.${field}`, LIMITS[field]);
      if (fieldError) errors.push(fieldError);
    }
  }
  const locales = body.locales;
  if (!Array.isArray(locales) || locales.length === 0) {
    errors.push('"locales" must be a non-empty list of app language codes other than "en"');
  } else {
    const bad = locales.filter((locale) => !isAppLocale(locale) || locale === 'en');
    if (bad.length) errors.push(`"locales" has codes that cannot be translated to: ${bad.join(', ')}`);
    if (new Set(locales).size !== locales.length) errors.push('"locales" lists a language twice');
  }
  if (errors.length) {
    res.status(400).json({ error: 'invalid_payload', details: errors });
    return;
  }

  const { fields, system, user, jsonSchema } = translationPrompt(source, locales);
  let generated;
  try {
    generated = await providerGateway.generate({
      profile: 'fast',
      system,
      user,
      jsonSchema,
      maxOutputTokens: 4000,
      temperature: 0.2,
    });
  } catch (err) {
    if (err instanceof providerGateway.AllProvidersFailedError) {
      console.error(`[admin] POST /v1/admin/translate failed, kind=${err.kind}`);
      if (err.kind === 'rateLimit') {
        res.status(429).json({ error: 'The translation service is rate-limited. Try again in a minute.' });
        return;
      }
      res.status(503).json({ error: 'The translation service is unavailable right now. Try again, or translate by hand.' });
      return;
    }
    console.error(`[admin] POST /v1/admin/translate unexpected error: ${err.message}`);
    res.status(500).json({ error: 'Translation failed.' });
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(generated.text);
  } catch (_err) {
    parsed = null;
  }
  if (!parsed || !Array.isArray(parsed.translations)) {
    console.error('[admin] POST /v1/admin/translate: model output was not the expected JSON');
    res.status(502).json({ error: 'The translation came back in an unexpected shape. Try again.' });
    return;
  }

  const translations = {};
  const problems = [];
  for (const item of parsed.translations) {
    if (!item || typeof item !== 'object' || !locales.includes(item.locale) || translations[item.locale]) continue;
    const entry = {};
    for (const field of fields) {
      const value = typeof item[field] === 'string' ? item[field].trim() : '';
      if (!value) {
        problems.push({ locale: item.locale, field, message: 'no translation returned' });
        continue;
      }
      entry[field] = value;
      const length = charCount(value);
      if (length > LIMITS[field]) {
        problems.push({ locale: item.locale, field, message: `${length} characters; the limit is ${LIMITS[field]} — shorten it before saving` });
      }
    }
    translations[item.locale] = entry;
  }
  for (const locale of locales) {
    if (!translations[locale]) problems.push({ locale, field: null, message: 'no translation returned for this language' });
  }

  res.status(200).json({ translations, problems, provider: generated.provider, model: generated.model });
});

module.exports = router;
