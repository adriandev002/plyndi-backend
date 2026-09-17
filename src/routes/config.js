// ============================================================================
// GET /v1/config — Phase 0 kill switch / version gate (Plyndi-AI-Hub-Design.md §7).
// ----------------------------------------------------------------------------
// Response shape is NOT a design decision here — it must match exactly what
// RemoteConfig.swift already decodes in the shipping iOS app. See that file's
// header comment for the fail-open contract this mirrors on the server side.
// ============================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');

const { compareVersions } = require('../lib/semver');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'remote-config.json');

// Hardcoded last-resort default: everything enabled, no version gate. Served only when the
// on-disk config is missing or fails validation, so a broken/corrupted deploy of
// remote-config.json can never brick the app fleet — that would turn the safety mechanism into
// the outage it exists to prevent.
const PERMISSIVE_FALLBACK = Object.freeze({
  configVersion: 0,
  minSupportedVersion: '0.0.0',
  recommendedVersion: '0.0.0',
  updateUrl: '',
  features: {
    ai_hub: true,
    budget_insights: true,
    daily_plan: true,
    shopping_suggestions: true,
    quick_add_parse: true,
    receipt_scan: true,
    trip_itinerary_day: true,
    workout_plan: true,
    form_coach: true,
    readiness: true
  },
  messages: { banner: null },
  ttlSeconds: 900
});

let currentConfig = PERMISSIVE_FALLBACK;

function isValidShape(parsed) {
  return (
    parsed !== null &&
    typeof parsed === 'object' &&
    typeof parsed.configVersion === 'number' &&
    typeof parsed.minSupportedVersion === 'string' &&
    typeof parsed.recommendedVersion === 'string' &&
    typeof parsed.updateUrl === 'string' &&
    typeof parsed.features === 'object' && parsed.features !== null &&
    typeof parsed.messages === 'object' && parsed.messages !== null &&
    typeof parsed.ttlSeconds === 'number'
  );
}

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!isValidShape(parsed)) {
      throw new Error('missing required fields or wrong types');
    }
    currentConfig = parsed;
    console.log(`[config] loaded remote-config.json — configVersion=${parsed.configVersion}`);
  } catch (err) {
    currentConfig = PERMISSIVE_FALLBACK;
    console.error(
      `[config] FAILED to load remote-config.json (${err.message}) — serving the permissive ` +
      'fallback (everything enabled, no version gate) instead. Fix and reload with SIGHUP.'
    );
  }
}

loadConfig();
// Edit remote-config.json on the host and `kill -HUP <pid>` to reload it in place — no Render
// restart/redeploy needed to flip a kill switch or bump the version gate.
process.on('SIGHUP', loadConfig);

const router = express.Router();

// /v1/config IS the kill switch — the general-purpose per-IP limiter in server.js must never be
// able to lock a client out of learning that a feature has been disabled or an update is
// required, so this route gets its own, far more generous ceiling instead of sharing that one.
// (It's also mounted in server.js ahead of the global limiter, so that one never even sees it.)
const configLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' }
});

router.get('/', configLimiter, (req, res) => {
  const cfg = currentConfig;
  const callerVersion = req.appContext ? req.appContext.appVersion : null;

  const cmpMin = compareVersions(callerVersion, cfg.minSupportedVersion);
  const cmpRec = compareVersions(callerVersion, cfg.recommendedVersion);

  const body = {
    configVersion: cfg.configVersion,
    minSupportedVersion: cfg.minSupportedVersion,
    recommendedVersion: cfg.recommendedVersion,
    // A missing/unparseable caller version can't be proven out of date, so it never triggers a
    // forced update — fails open. Locking a user out because a header was absent is far worse
    // than serving one stale/permissive config.
    updateRequired: cmpMin === -1,
    updateRecommended: cmpRec === -1,
    updateUrl: cfg.updateUrl,
    features: cfg.features,
    messages: cfg.messages,
    ttlSeconds: cfg.ttlSeconds
  };

  // ETag covers everything except serverTime, which is set fresh below on every response and
  // would otherwise change the hash (and defeat 304s) on every single request.
  const etag = `"${crypto.createHash('sha1').update(JSON.stringify(body)).digest('hex')}"`;
  res.set('ETag', etag);
  // The iOS client already runs its own ttlSeconds disk cache (RemoteConfigService), so an HTTP
  // max-age here would stack a second, invisible staleness layer on top of it: an urgent kill
  // switch flip could then sit unseen inside URLSession's cache for the whole max-age window.
  // no-cache forces revalidation on every request; the ETag above still saves the bandwidth via
  // 304s for clients (e.g. a future Android build) that do send If-None-Match.
  res.set('Cache-Control', 'no-cache');

  if (req.get('If-None-Match') === etag) {
    res.status(304).end();
    return;
  }

  res.status(200).json({ ...body, serverTime: new Date().toISOString() });
});

module.exports = router;
