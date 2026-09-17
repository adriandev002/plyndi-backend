// ============================================================================
// POST /v1/ai/run — run one AI Hub capability (Plyndi-AI-Hub-Design.md §4.3, Phase 1-A).
// ----------------------------------------------------------------------------
// The client sends a capability id and a context object; it never sends a prompt, a schema, or a
// model name — that discipline is what makes a prompt fix a backend deploy instead of an App
// Store release. This route owns validating the request, rendering the prompt, and calling
// providerGateway.generate() directly (never over HTTP — see providerGateway.js's header comment
// for why a loopback call to /v1/generate would be wrong).
//
//   POST /v1/ai/run
//   { capabilityId, contextVersion, context, idempotencyKey, locale }
//   → { runId, status, result, provider, model, latencyMs, capabilityVersion }
//
//   GET /v1/ai/runs?limit=&cursor=  → { runs: [...], nextCursor }  (insight feed / history)
//
// Mounted at /v1/ai in src/server.js, so this file owns both /v1/ai/run and /v1/ai/runs.
// Auth, rate limiting, body parsing and sanitising are already applied globally in src/server.js
// before this router is reached, same as /v1/generate.
//
// Credits, per-user JWT identity and the hub catalog are Phase 2-3, deliberately not here yet —
// see the file-level comments on runStore.js for what "no per-user identity yet" means in
// practice for idempotency/listing.
// ============================================================================

const crypto = require('crypto');
const express = require('express');
const router = express.Router();

const registry = require('../lib/capabilityRegistry');
const runStore = require('../lib/runStore');
const providerGateway = require('../lib/providerGateway');
const { compareVersions } = require('../lib/semver');
const { validate: validateContext } = require('../lib/jsonSchemaLite');
const { renderPromptTemplate } = require('../lib/renderPromptTemplate');

// A hard ceiling on the serialized `context` payload, independent of and stricter than the
// global express.json({limit:'1mb'}) body cap in server.js — this exists specifically so a huge
// context can be rejected before it ever reaches a provider (and gets billed), not just before it
// reaches this process at all.
const CONTEXT_MAX_BYTES = Number(process.env.AI_CONTEXT_MAX_BYTES || 20000);

// No per-user identity until Phase 3's JWT lands (see runStore.js) — every run is scoped under
// one constant bucket for now, so idempotency/listing work per-deployment rather than per-user.
const ANONYMOUS_SCOPE = 'anonymous';

function toResponse(run) {
  return {
    runId: run.runId,
    status: run.status,
    result: run.result,
    provider: run.provider,
    model: run.model,
    latencyMs: run.latencyMs,
    capabilityVersion: run.capabilityVersion,
  };
}

router.post('/run', async (req, res) => {
  const { capabilityId, contextVersion, context = {}, idempotencyKey, locale } = req.body || {};

  // 1. look up capability; 404 if unknown.
  const capability = registry.get(capabilityId);
  if (!capability) {
    return res.status(404).json({ error: 'unknown_capability' });
  }

  // 2. enabled + version gate. A missing/unparseable caller version fails OPEN (does not block) —
  // the same convention src/routes/config.js already established for the app-wide version gate,
  // kept consistent here rather than inventing a second rule for this one.
  if (!capability.enabled) {
    return res.status(403).json({ error: 'capability_disabled' });
  }
  const callerVersion = req.appContext ? req.appContext.appVersion : null;
  if (compareVersions(callerVersion, capability.minAppVersion) === -1) {
    return res.status(403).json({ error: 'app_update_required', minAppVersion: capability.minAppVersion });
  }

  // 3. validate context against contextSchema and cap its size — REJECT BEFORE SPENDING MONEY.
  // An invalid or oversized context must never reach a provider.
  const contextBytes = Buffer.byteLength(JSON.stringify(context ?? null), 'utf8');
  if (contextBytes > CONTEXT_MAX_BYTES) {
    return res.status(400).json({ error: 'context_too_large', maxBytes: CONTEXT_MAX_BYTES });
  }
  const contextProblem = validateContext(capability.contextSchema, context);
  if (contextProblem) {
    return res.status(400).json({ error: 'invalid_context', reason: contextProblem });
  }

  // 4. idempotencyKey: a replay returns the stored run, never a second provider call.
  if (idempotencyKey) {
    const existing = runStore.findByIdempotencyKey(ANONYMOUS_SCOPE, idempotencyKey);
    if (existing) {
      return res.status(200).json(toResponse(existing));
    }
  }

  // 5. render the prompt. Only {{context.<path>}} placeholders are substituted (see
  // renderPromptTemplate.js for the JSON-encoding/injection rationale); locale is exposed to the
  // template the same way by merging it onto a copy of the context, never onto the system prompt.
  const renderContext = { ...context, locale: locale ?? null };
  const userPrompt = renderPromptTemplate(capability.userPromptTemplate, renderContext);

  // 6. call the provider gateway directly — no HTTP loopback to /v1/generate (see
  // providerGateway.js's header comment).
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
    // Map to a stable, non-technical error code + HTTP status. Never echo the provider's raw
    // message to the client — providerGateway.generate() already logged it server-side.
    if (err instanceof providerGateway.UnknownProfileError) {
      console.error(`[ai/run] capability "${capabilityId}" references unconfigured profile "${capability.profile}"`);
      return res.status(503).json({ error: 'service_unavailable' });
    }
    if (err instanceof providerGateway.AllProvidersFailedError) {
      console.error(`[ai/run] capability "${capabilityId}" run failed, kind=${err.kind}`);
      if (err.kind === 'rateLimit') return res.status(429).json({ error: 'rate_limited' });
      return res.status(503).json({ error: 'provider_unavailable' });
    }
    console.error(`[ai/run] unexpected error running "${capabilityId}": ${err.message}`);
    return res.status(500).json({ error: 'internal_error' });
  }

  // 7. parse and return the result; store the run. Validate ONLY that it parsed and is
  // structurally present (an object) — never gate acceptance on a specific field being non-null.
  // That exact mistake (requiring a field a later phase legitimately overwrites/omits) emptied
  // every itinerary in production once; see Plyndi-AI-Hub-Design.md §1.6 and §2.6.
  let result;
  try {
    result = JSON.parse(generated.text);
  } catch (err) {
    console.error(`[ai/run] capability "${capabilityId}" provider returned non-JSON output: ${err.message}`);
    return res.status(502).json({ error: 'invalid_provider_response' });
  }
  if (result === null || typeof result !== 'object') {
    console.error(`[ai/run] capability "${capabilityId}" provider returned a non-object JSON value`);
    return res.status(502).json({ error: 'invalid_provider_response' });
  }

  const run = {
    runId: crypto.randomUUID(),
    status: 'succeeded',
    capabilityId,
    capabilityVersion: capability.version,
    contextVersion: contextVersion ?? null,
    result,
    provider: generated.provider,
    model: generated.model,
    latencyMs: generated.latencyMs,
    createdAtMs: Date.now(),
    idempotencyKey: idempotencyKey || null,
    scopeKey: ANONYMOUS_SCOPE,
  };
  runStore.save(run);

  return res.status(200).json(toResponse(run));
});

// GET /v1/ai/runs — insight feed / history, paginated. Scoped to the same coarse anonymous
// bucket as POST /run above until Phase 3's per-user JWT lands (see runStore.js).
router.get('/runs', (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
  const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : null;
  const items = runStore.listByUser(ANONYMOUS_SCOPE, limit, cursor);
  res.status(200).json({
    runs: items.map((run) => ({ ...toResponse(run), capabilityId: run.capabilityId, createdAt: new Date(run.createdAtMs).toISOString() })),
    nextCursor: items.length === limit ? items[items.length - 1].runId : null,
  });
});

module.exports = router;
