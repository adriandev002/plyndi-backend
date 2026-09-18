// ============================================================================
// Daily Brief — Plyndi-AI-Hub-Design.md §3.1, §4.1, Phase 4-A.
// ----------------------------------------------------------------------------
//   POST /v1/ai/brief/digest  { localDate, timeZone, digest }  → { stored: true, localDate }
//   GET  /v1/ai/brief?localDate=YYYY-MM-DD
//     → 200 { brief, localDate, generatedAt, cached, provider, model }
//     → 204 (no body) — no digest posted yet for this day; the normal first-run state
//     → 400/403/429/502/503 { error: <code> } — see the per-branch comments below
//
// THE SERVER CANNOT READ THE USER'S DATA (design doc's constraint #1 — everything lives
// on-device, /v1/sync has zero call sites). The app POSTs a small digest; this route only ever
// reads that digest back. POST never generates — generation costs money and must not fire from a
// background sync the user never sees the result of. GET generates AT MOST ONCE PER (subject,
// localDate), cached thereafter — constraint #2, "one provider call per user per day" is the
// feature's entire economics.
//
// ---------------------------------------------------------------------------------------------
// "Today" is the USER'S day, not UTC. A brief cached under a UTC date would arrive at 8am in
// Taipei (UTC+8) labelled with yesterday's numbers, and would regenerate mid-morning when UTC
// rolls over. The client therefore sends its own `localDate` (YYYY-MM-DD, the app's own idea of
// "today") and `timeZone` (IANA, informational — validated so a client sending garbage is caught
// early, but not itself part of the cache key); the cache key src/lib/store/*.js's saveBrief/
// getBrief use is (subject, localDate) alone. `localDate` is validated strictly
// (`^\d{4}-\d{2}-\d{2}$`, and a real calendar date) and rejected if it's more than a couple of
// days from the SERVER's own UTC date — generously wide enough to cover every real timezone
// offset (UTC-12..+14), narrow enough that a bad or hostile client can't mint unlimited cache
// entries and, through them, unlimited provider calls (each one a real GET that reaches the
// "no brief cached yet" branch and tries to generate).
// ---------------------------------------------------------------------------------------------
//
// FREE TO THE USER, NOT FREE TO US. daily_brief.json's `creditCost` is 0 (Plyndi-AI-Hub-Design.md
// §6 — the brief is free for everyone, it's the daily habit, habits don't sit behind a wall).
// daily_brief is DELIBERATELY NOT loaded by src/lib/capabilityRegistry.js and is therefore
// unreachable through the generic POST /v1/ai/run (see this route's own loader below and
// capabilityRegistry.js's header comment for why: that route charges and caps purely by
// `creditCost`, so a 0-cost capability would be able to trigger unlimited, uncached generations
// through it, tripping neither the per-subject allowance nor the global daily cap). But a
// generation through THIS route IS a real provider call, so it still must count toward the GLOBAL
// daily spend cap (`AI_DAILY_CREDIT_CAP`, the same env var and the same store.globalSpendToday()
// POST /v1/ai/run checks) — the ledger row this route writes uses daily_brief.json's
// `globalSpendCost` field (a real-cost weight, independent of and NOT the same as `creditCost`)
// and passes `countsTowardAllowance: false` to store.recordCredit so it's counted by
// globalSpendToday() but excluded from creditsUsed() (see src/lib/store/*.js and
// db/schema.sql's counts_toward_allowance column comment). Getting this backwards — using
// creditCost (0) for the global-cap delta, or letting the entry decrement a subject's
// allowance — is the single easiest way for this route to either cost real money with no
// ceiling, or silently overcharge free users for a feature the design says must never bill them.
// ============================================================================

const fs = require('fs');
const path = require('path');
const express = require('express');
const router = express.Router();

const store = require('../lib/store');
const providerGateway = require('../lib/providerGateway');
const { compareVersions } = require('../lib/semver');
const { validate: validateContext } = require('../lib/jsonSchemaLite');
const { renderPromptTemplate } = require('../lib/renderPromptTemplate');
const subjectLib = require('../lib/subject');

const CAPABILITY_ID = 'daily_brief';

// Same cap and default as src/routes/aiRun.js's CONTEXT_MAX_BYTES — re-declared rather than
// imported (aiRun.js doesn't export it), same convention src/routes/aiHub.js already follows for
// reading remote-config.json independently of src/routes/config.js.
const CONTEXT_MAX_BYTES = Number(process.env.AI_CONTEXT_MAX_BYTES || 20000);
// Same env var and default POST /v1/ai/run's dailyCreditCap() reads — ONE global ceiling shared
// by every capability, generic vs. daily_brief-specific spend.
function dailyCreditCap() {
  return Number(process.env.AI_DAILY_CREDIT_CAP) || 2000;
}

// ---------------------------------------------------------------------------
// capabilities/daily_brief.json — loaded and validated HERE, deliberately not through
// src/lib/capabilityRegistry.js (see this file's header comment for why). Same boot-load +
// in-memory cache + SIGHUP reload pattern as capabilityRegistry.js/config.js/aiHub.js, scoped to
// this one file. A malformed file is not a boot failure — every route below reports
// `capability_disabled`/`unknown_capability` until it's fixed and reloaded, the same "never take
// the rest of the service down" posture every other loader in this repo already takes.
// ---------------------------------------------------------------------------
const CAPABILITY_PATH = path.join(__dirname, '..', '..', 'capabilities', 'daily_brief.json');
let capability = null;

function validateCapability(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'not a JSON object';
  if (parsed.id !== CAPABILITY_ID) return `"id" field ("${parsed.id}") does not match "${CAPABILITY_ID}"`;
  if (typeof parsed.version !== 'number' || !Number.isFinite(parsed.version)) return '"version" must be a number';
  if (parsed.profile !== 'fast' && parsed.profile !== 'rich') return '"profile" must be "fast" or "rich"';
  if (!Number.isInteger(parsed.maxOutputTokens) || parsed.maxOutputTokens <= 0) {
    return '"maxOutputTokens" must be a positive integer';
  }
  // Unlike every capability in src/lib/capabilityRegistry.js, 0 is the EXPECTED value here — the
  // brief is free for every user (Plyndi-AI-Hub-Design.md §6). Only negative is rejected.
  if (!Number.isInteger(parsed.creditCost) || parsed.creditCost < 0) {
    return '"creditCost" must be a non-negative integer';
  }
  // The real per-generation cost against the GLOBAL daily cap — see this file's header comment.
  // Required (unlike creditCost, this capability's whole reason for a separate field) so a typo'd
  // or forgotten value can never silently become "free against the cap too".
  if (!Number.isInteger(parsed.globalSpendCost) || parsed.globalSpendCost <= 0) {
    return '"globalSpendCost" must be a positive integer';
  }
  if (typeof parsed.enabled !== 'boolean') return '"enabled" must be a boolean';
  if (typeof parsed.minAppVersion !== 'string' || !parsed.minAppVersion) return '"minAppVersion" must be a non-empty string';
  if (typeof parsed.systemPrompt !== 'string' || !parsed.systemPrompt) return '"systemPrompt" must be a non-empty string';
  if (typeof parsed.userPromptTemplate !== 'string' || !parsed.userPromptTemplate) {
    return '"userPromptTemplate" must be a non-empty string';
  }
  if (!parsed.jsonSchema || typeof parsed.jsonSchema !== 'object') return '"jsonSchema" must be an object';
  if (!parsed.contextSchema || typeof parsed.contextSchema !== 'object') return '"contextSchema" must be an object';
  return null;
}

function loadCapability() {
  try {
    const raw = fs.readFileSync(CAPABILITY_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const problem = validateCapability(parsed);
    if (problem) throw new Error(problem);
    capability = parsed;
    console.log('[ai/brief] loaded capabilities/daily_brief.json');
  } catch (err) {
    capability = null;
    console.error(`[ai/brief] FAILED to load capabilities/daily_brief.json (${err.message}) — GET/POST /v1/ai/brief* will report unknown_capability until fixed and reloaded.`);
  }
}
loadCapability();
// Edit capabilities/daily_brief.json on the host and `kill -HUP <pid>` to reload it, no restart —
// same convention as every other loader in this repo.
process.on('SIGHUP', loadCapability);

// ---------------------------------------------------------------------------
// remote-config.json's feature flags, read independently of src/routes/config.js (never touch
// that file) — the exact same pattern and the exact same reasoning src/routes/aiHub.js already
// documents for itself: a kill switch flip must be honoured here via its own SIGHUP reload,
// without adding a second consumer of config.js's internals.
// ---------------------------------------------------------------------------
const REMOTE_CONFIG_PATH = path.join(__dirname, '..', 'config', 'remote-config.json');
let remoteFeatures = {};

function loadRemoteFeatures() {
  try {
    const raw = fs.readFileSync(REMOTE_CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    remoteFeatures = (parsed && typeof parsed.features === 'object' && parsed.features) || {};
  } catch (err) {
    // Fails open, same convention config.js/aiHub.js document for their own permissive fallbacks:
    // an unreadable remote-config.json must never take the Daily Brief down.
    remoteFeatures = {};
    console.error(`[ai/brief] FAILED to read remote-config.json for feature flags (${err.message}) — treating daily_brief as enabled.`);
  }
}
loadRemoteFeatures();
process.on('SIGHUP', loadRemoteFeatures);

// ---------------------------------------------------------------------------
// localDate / timeZone validation.
// ---------------------------------------------------------------------------
const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
// How far a client's claimed "today" may drift from the server's own UTC "today" before it's
// refused. Wide enough to cover every real UTC offset (a timezone can be up to a day ahead or
// behind UTC's own calendar date depending on time of day), narrow enough that a bad/hostile
// client can't mint arbitrary cache entries — each one a real attempted provider call the first
// time it's GET'd.
const LOCAL_DATE_TOLERANCE_DAYS = 2;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function startOfUtcDay(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
}

function isValidLocalDate(value) {
  if (typeof value !== 'string' || !LOCAL_DATE_PATTERN.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(ms)) return false;
  // Reject a syntactically-shaped but impossible calendar date (e.g. 2026-02-30) — Date.parse
  // silently rolls those over into the next month instead of failing.
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(ms);
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() + 1 !== month || parsed.getUTCDate() !== day) {
    return false;
  }
  const diffDays = Math.round((ms - startOfUtcDay().getTime()) / MS_PER_DAY);
  return Math.abs(diffDays) <= LOCAL_DATE_TOLERANCE_DAYS;
}

function isValidTimeZone(value) {
  if (typeof value !== 'string' || !value || value.length > 64) return false;
  try {
    // eslint-disable-next-line no-new
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch (_err) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Visibility gate — mirrors src/routes/aiRun.js's enabled/minAppVersion checks (same precedence:
// disabled before version) plus src/routes/aiHub.js's independent remote-config feature check, so
// "disabled" means the same thing everywhere a capability can be turned off. A missing/
// unparseable caller version fails OPEN, same convention as every other version gate in this repo.
// Returns null when usable, or the error response body to send when not.
// ---------------------------------------------------------------------------
function capabilityGateError(capability, callerVersion) {
  if (!capability.enabled || remoteFeatures[CAPABILITY_ID] === false) {
    return { status: 403, body: { error: 'capability_disabled' } };
  }
  if (compareVersions(callerVersion, capability.minAppVersion) === -1) {
    return { status: 403, body: { error: 'app_update_required', minAppVersion: capability.minAppVersion } };
  }
  return null;
}

// ---------------------------------------------------------------------------
// POST /v1/ai/brief/digest — stores the client's daily digest. NEVER calls the provider.
// Idempotent: re-posting the same day's digest overwrites the stored digest, and — by
// construction of store.saveBrief's upsert (see src/lib/store/*.js) — can never blank out or
// invalidate an already-generated brief, so a background digest refresh never re-bills a day
// that's already been served.
// ---------------------------------------------------------------------------
router.post('/digest', async (req, res) => {
  if (!capability) {
    return res.status(404).json({ error: 'unknown_capability' });
  }

  const { localDate, timeZone, digest } = req.body || {};
  if (!isValidLocalDate(localDate)) {
    return res.status(400).json({ error: 'invalid_local_date' });
  }
  if (!isValidTimeZone(timeZone)) {
    return res.status(400).json({ error: 'invalid_time_zone' });
  }

  const digestValue = digest === undefined || digest === null ? {} : digest;
  const digestBytes = Buffer.byteLength(JSON.stringify(digestValue), 'utf8');
  if (digestBytes > CONTEXT_MAX_BYTES) {
    return res.status(400).json({ error: 'context_too_large', maxBytes: CONTEXT_MAX_BYTES });
  }
  const problem = validateContext(capability.contextSchema, digestValue);
  if (problem) {
    return res.status(400).json({ error: 'invalid_context', reason: problem });
  }

  // Storing a digest is free (no provider call) — deliberately NOT gated on isCapabilityUsable(),
  // so a digest posted while daily_brief is mid-kill-switch is ready to generate the instant it's
  // flipped back on, without asking the app to re-POST it.
  const { subject } = subjectLib.resolveSubject(req);
  await store.saveBrief({ subject, localDate, digest: digestValue });

  return res.status(200).json({ stored: true, localDate });
});

// ---------------------------------------------------------------------------
// GET /v1/ai/brief?localDate=YYYY-MM-DD
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  const callerVersion = req.appContext ? req.appContext.appVersion : null;
  if (!capability) {
    return res.status(404).json({ error: 'unknown_capability' });
  }

  const localDate = typeof req.query.localDate === 'string' ? req.query.localDate : null;
  if (!isValidLocalDate(localDate)) {
    return res.status(400).json({ error: 'invalid_local_date' });
  }

  const gateError = capabilityGateError(capability, callerVersion);
  if (gateError) {
    return res.status(gateError.status).json(gateError.body);
  }

  const { subject, verified } = subjectLib.resolveSubject(req);
  const existing = await store.getBrief(subject, localDate);

  // Already generated today → return the cache. NO provider call. This is the common case and
  // the entire point of the (subject, localDate) cache key.
  if (existing && existing.briefText) {
    return res.status(200).json({
      brief: existing.briefText,
      localDate,
      generatedAt: new Date(existing.createdAtMs).toISOString(),
      cached: true,
      provider: existing.provider,
      model: existing.model,
    });
  }

  // No digest posted yet for this day → the normal first-run state, not an error. Nothing to
  // generate from, so no provider call is even attempted.
  if (!existing || !existing.digest) {
    return res.status(204).end();
  }

  // GLOBAL DAILY SPEND CAP — checked BEFORE any provider call, exactly like POST /v1/ai/run's own
  // check (same env var, same store.globalSpendToday()). The brief is free to the user
  // (creditCost 0) but real spend, so it uses globalSpendCost — a required field, validated above
  // — for the delta, never creditCost. See this file's header comment.
  const spendCost = capability.globalSpendCost;
  const dailyCap = dailyCreditCap();
  const spentToday = await store.globalSpendToday();
  if (spentToday + spendCost > dailyCap) {
    return res.status(429).json({ error: 'daily_capacity_reached' });
  }

  // Render + generate. Same call shape as src/routes/aiRun.js's step 8/9 — providerGateway.generate()
  // directly, in-process, never a loopback HTTP call.
  const renderContext = { ...existing.digest };
  const userPrompt = renderPromptTemplate(capability.userPromptTemplate, renderContext);

  let generated;
  try {
    generated = await providerGateway.generate({
      profile: capability.profile,
      system: capability.systemPrompt,
      user: userPrompt,
      jsonSchema: capability.jsonSchema,
      maxOutputTokens: capability.maxOutputTokens,
      temperature: capability.temperature,
    });
  } catch (err) {
    if (err instanceof providerGateway.UnknownProfileError) {
      console.error(`[ai/brief] capability "${CAPABILITY_ID}" references unconfigured profile "${capability.profile}"`);
      return res.status(503).json({ error: 'service_unavailable' });
    }
    if (err instanceof providerGateway.AllProvidersFailedError) {
      console.error(`[ai/brief] generation failed, kind=${err.kind}`);
      if (err.kind === 'rateLimit') return res.status(429).json({ error: 'rate_limited' });
      return res.status(503).json({ error: 'provider_unavailable' });
    }
    console.error(`[ai/brief] unexpected error generating: ${err.message}`);
    return res.status(503).json({ error: 'provider_unavailable' });
  }

  let parsed;
  try {
    parsed = JSON.parse(generated.text);
  } catch (err) {
    console.error(`[ai/brief] provider returned non-JSON output: ${err.message}`);
    return res.status(502).json({ error: 'invalid_provider_response' });
  }
  // Same rule as aiRun.js's step 10: validate only that a usable string came back, never gate on
  // more than that (Plyndi-AI-Hub-Design.md §1.6/§2.6 — the null-leg bug).
  const briefText = parsed && typeof parsed.brief === 'string' && parsed.brief.trim() ? parsed.brief.trim() : null;
  if (!briefText) {
    console.error('[ai/brief] provider response parsed but had no usable "brief" string');
    return res.status(502).json({ error: 'invalid_provider_response' });
  }

  // Save FIRST, then bill — mirrors aiRun.js debiting only after a successful run. Note: two
  // concurrent first-of-day GETs for the same (subject, localDate) can both reach this point and
  // both call the provider (there is no per-request lock here, unlike POST /v1/ai/run's
  // idempotencyKey) — store.saveBrief's upsert (see src/lib/store/*.js) ensures only the FIRST
  // write's brief_text is ever kept, so the cache is still correct, but a same-instant race can
  // spend twice against the global cap. Accepted as a rare, bounded edge case for this phase
  // (a normal client only ever issues one such GET per app-foreground per day).
  const saved = await store.saveBrief({
    subject,
    localDate,
    briefText,
    provider: generated.provider,
    model: generated.model,
  });
  await store.recordCredit({
    subject,
    verified,
    capabilityId: CAPABILITY_ID,
    creditCost: spendCost,
    runId: null,
    countsTowardAllowance: false,
  });

  return res.status(200).json({
    brief: briefText,
    localDate,
    generatedAt: new Date(saved.createdAtMs).toISOString(),
    cached: false,
    provider: generated.provider,
    model: generated.model,
  });
});

module.exports = router;
// Exposed for scripts/test-ai-brief.js only — production code never calls these directly.
module.exports.loadRemoteFeatures = loadRemoteFeatures;
module.exports.loadCapability = loadCapability;
