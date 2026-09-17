// ============================================================================
// POST /v1/generate — provider-agnostic AI generation.
// ----------------------------------------------------------------------------
// The client sends WHAT it wants ("a rich JSON answer to this prompt"), never
// WHO should answer it. Which model serves a profile is decided here, from
// environment variables, so swapping or retiring a model is a Render env change
// and a redeploy — not an App Store release that users must install.
//
//   POST /v1/generate
//   { profile, schemaVersion, system, user, jsonSchema?, maxOutputTokens?, temperature? }
//   → { text, provider, model, latencyMs, attempts }
//
// Auth, rate limiting, body parsing and sanitising are already applied globally
// in src/server.js before this router is reached — deliberately not repeated here.
//
// This file is now a thin HTTP wrapper: the actual model-chain/circuit-breaker/schema-
// translation logic lives in src/lib/providerGateway.js, shared with POST /v1/ai/run so that
// route can call the gateway in-process instead of looping back over HTTP to this route.
// ============================================================================

const express = require('express');
const router = express.Router();

const providerGateway = require('../lib/providerGateway');

const MIN_SCHEMA_VERSION = Number(process.env.MIN_SCHEMA_VERSION || 1);

router.post('/', async (req, res) => {
  const {
    profile = 'fast',
    schemaVersion = 1,
    system,
    user,
    jsonSchema,
    maxOutputTokens,
    temperature,
  } = req.body || {};

  if (!system || !user) return res.status(400).json({ error: 'system_and_user_required' });

  // An older install may not understand what the current chain returns. Say so
  // plainly so the app can show "please update" instead of failing to decode.
  if (Number(schemaVersion) < MIN_SCHEMA_VERSION) {
    return res.status(426).json({ error: 'client_too_old', minSchemaVersion: MIN_SCHEMA_VERSION });
  }

  try {
    const result = await providerGateway.generate({ profile, system, user, jsonSchema, maxOutputTokens, temperature });
    return res.json(result);
  } catch (error) {
    if (error instanceof providerGateway.UnknownProfileError) {
      return res.status(400).json({ error: 'unknown_profile', profile });
    }
    if (error instanceof providerGateway.AllProvidersFailedError) {
      return res.status(503).json({
        error: 'all_providers_failed',
        kind: error.kind,
        latencyMs: error.latencyMs,
        attempts: error.attempts,
      });
    }
    throw error;
  }
});

// What is each profile routed to right now, and which models are in cooldown.
router.get('/models', (_req, res) => {
  const now = Date.now();
  res.json({
    profiles: Object.fromEntries(Object.keys(providerGateway.DEFAULT_CHAINS).map((p) => [p, providerGateway.chainFor(p)])),
    breakers: [...providerGateway.breakers.entries()]
      .filter(([, state]) => state.openUntil > now)
      .map(([model, state]) => ({ model, secondsRemaining: Math.round((state.openUntil - now) / 1000) })),
    minSchemaVersion: MIN_SCHEMA_VERSION,
  });
});

module.exports = router;
