// Minimal product-funnel analytics ingestion — POST /v1/analytics/events.
//
// Scope: the paywall/trial/purchase funnel ONLY (paywall_viewed → trial_started →
// purchased/cancelled) plus the ActivationTracker events the iOS app already defines
// (onboarding_started/completed, first_*, today_viewed, user_activated). This is NOT a
// general analytics platform: no querying, no dashboards, no user profiles — events land
// in analytics_events (db/schema.sql) and in the server logs, and that's it.
//
// Body: { event: "<name>", properties: { "<k>": "<v>" }, deviceId: "<uuid>" }
//   - event: required, must be in EVENT_ALLOWLIST below (anything else is dropped whole).
//   - properties: optional string->string map, at most 8 entries; keys <= 64 chars,
//     values <= 256 chars. Anything else is dropped whole (never partly applied).
//   - deviceId: optional anonymous install id (the iOS app's DeviceIdentity.current — a
//     random UUID, not PII). Stored so funnel steps can be joined per install, never
//     linked to a person.
//
// ALWAYS 204. The app fires and forgets; nothing it could learn from a 4xx would change
// what it does next, and a bad body must never become a 500. A body that breaks any rule
// is dropped whole (nothing stored). Rate-limited requests are dropped the same way —
// 204, not 429, so no client ever retries into the limit. (A malformed JSON body never
// reaches this handler at all: src/server.js turns express.json()'s parse error into a
// 204 for this path, the same carve-out /v1/content/home-banners/impressions has.)
//
// Mounted by src/server.js AFTER requireClientKey but BEFORE the general per-IP limiter
// (same placement as the impressions endpoint): analytics pings must not spend the
// 60-an-hour budget that guards the paid AI routes. They skip sanitizeBody like the
// impressions endpoint — events carry no PII by construction (allowlisted names +
// string properties only), so the scrubber has nothing to do here.
//
// Privacy: no PII, no secrets, ever. Event names are allowlisted; properties are
// capped strings; deviceId is a random per-install UUID. If a future event needs richer
// context, it gets its own allowlist entry here — never a free-form bag.

const express = require('express');
const rateLimit = require('express-rate-limit');
const store = require('../lib/store');

// Must stay in sync with AnalyticsEvent.name in
// Plyndi/Growth/ActivationTracker.swift — the server drops anything not on this list.
const EVENT_ALLOWLIST = new Set([
  // Funnel (this task)
  'paywall_viewed',
  'trial_started',
  'purchased',
  'cancelled',
  // Activation (already defined client-side)
  'onboarding_started',
  'onboarding_completed',
  'first_task',
  'first_expense',
  'first_accountBalance',
  'first_shoppingItem',
  'first_workout',
  'first_trip',
  'today_viewed',
  'user_activated',
]);

const MAX_PROPERTIES = 8;
const MAX_KEY_LENGTH = 64;
const MAX_VALUE_LENGTH = 256;
const MAX_DEVICE_ID_LENGTH = 64;

// Funnel + activation events are sparse (a handful per install lifetime, a few per
// paywall session) — 120 per 5 minutes per IP is generous without letting a runaway
// client fill the table.
const analyticsLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: Number(process.env.ANALYTICS_EVENTS_RATE_LIMIT_MAX) || 120,
  standardHeaders: false,
  legacyHeaders: false,
  handler: (_req, res) => res.status(204).end(),
});

// Returns a clean { event, properties, deviceId } object, or null if the body breaks
// any rule (the caller drops it whole — still answering 204).
function readEvent(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const { event, properties, deviceId } = body;
  if (typeof event !== 'string' || !EVENT_ALLOWLIST.has(event)) return null;

  let cleanProperties = {};
  if (properties !== undefined) {
    if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return null;
    const entries = Object.entries(properties);
    if (entries.length > MAX_PROPERTIES) return null;
    for (const [key, value] of entries) {
      if (typeof key !== 'string' || typeof value !== 'string') return null;
      if (key.length === 0 || key.length > MAX_KEY_LENGTH) return null;
      if (value.length > MAX_VALUE_LENGTH) return null;
      cleanProperties[key] = value;
    }
  }

  let cleanDeviceId = null;
  if (deviceId !== undefined && deviceId !== null) {
    if (typeof deviceId !== 'string' || deviceId.length === 0 || deviceId.length > MAX_DEVICE_ID_LENGTH) {
      return null;
    }
    cleanDeviceId = deviceId;
  }

  return { event, properties: cleanProperties, deviceId: cleanDeviceId };
}

const eventsRouter = express.Router();

eventsRouter.post('/', analyticsLimiter, async (req, res) => {
  try {
    const parsed = readEvent(req.body);
    if (parsed) {
      const id = await store.recordAnalyticsEvent({ ...parsed, receivedAt: new Date() });
      // The Render log line IS the lightweight event viewer for now — Adrian's verify
      // step ("paywall opens → event lands in the backend log/store") reads these.
      // deviceId here is a random per-install UUID, not PII.
      console.log(
        `[analytics] #${id} event=${parsed.event} device=${parsed.deviceId ?? '-'} props=${JSON.stringify(parsed.properties)}`
      );
    }
  } catch (err) {
    console.error(`[analytics] POST /v1/analytics/events failed (answering 204 anyway): ${err.message}`);
  }
  res.status(204).end();
});

module.exports = { eventsRouter };
