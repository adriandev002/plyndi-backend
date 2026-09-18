// ============================================================================
// POST /v1/ai/run — run one AI Hub capability (Plyndi-AI-Hub-Design.md §4.3, Phase 1-A; credits +
// spend cap added in Phase 3-A, §4.5/§4.6/§7). The client sends a capability id and a context
// object; it never sends a prompt, a schema, or a model name — that discipline is what makes a
// prompt fix a backend deploy instead of an App Store release. This route owns validating the
// request, rendering the prompt, and calling providerGateway.generate() directly (never over HTTP
// — see providerGateway.js's header comment for why a loopback call to /v1/generate would be
// wrong).
//
//   POST /v1/ai/run
//   { capabilityId, contextVersion, context, idempotencyKey, locale }
//   → { runId, status, result, provider, model, latencyMs, capabilityVersion,
//       creditsRemaining, creditsResetAt }
//
//   GET /v1/ai/runs?limit=&cursor=  → { runs: [...], nextCursor }  (insight feed / history)
//
// Mounted at /v1/ai in src/server.js, so this file owns both /v1/ai/run and /v1/ai/runs.
// Auth, rate limiting, body parsing and sanitising are already applied globally in src/server.js
// before this router is reached, same as /v1/generate.
//
// Phase 3-A identity note: "who is calling" is device-scoped (src/lib/subject.js), not per-
// account — read that file's header before changing anything here. A request with NO identity
// headers at all (every build shipped before Phase 3-B) must keep succeeding; that is the whole
// point of AI_REQUIRE_VERIFIED_IDENTITY defaulting to false.
// ============================================================================

const crypto = require('crypto');
const express = require('express');
const router = express.Router();

const registry = require('../lib/capabilityRegistry');
const store = require('../lib/store');
const providerGateway = require('../lib/providerGateway');
const { compareVersions } = require('../lib/semver');
const { validate: validateContext } = require('../lib/jsonSchemaLite');
const { renderPromptTemplate } = require('../lib/renderPromptTemplate');
const subjectLib = require('../lib/subject');
const { currentBillingPeriod } = require('../lib/billingPeriod');

// A hard ceiling on the serialized `context` payload, independent of and stricter than the
// global express.json({limit:'1mb'}) body cap in server.js — this exists specifically so a huge
// context can be rejected before it ever reaches a provider (and gets billed), not just before it
// reaches this process at all.
const CONTEXT_MAX_BYTES = Number(process.env.AI_CONTEXT_MAX_BYTES || 20000);

// ---------------------------------------------------------------------------
// Phase 3-A credits (Plyndi-AI-Hub-Design.md §6) — SHADOW MODE by default.
// ---------------------------------------------------------------------------
// Read fresh from process.env on every request rather than cached once at module load — the same
// choice src/middleware/auth.js already makes for CLIENT_SHARED_KEY, reused here rather than
// invented twice, and it's what lets scripts/test-ai-credits.js flip AI_CREDITS_ENFORCE mid-run
// against one already-listening server instead of spawning a second process per scenario.
//
// AI_CREDITS_ENFORCE=false (the default): an over-allowance subject is logged and STILL SERVED.
// The first guess at credit pricing is always wrong; real usage data has to exist before
// enforcement can be tuned responsibly. Flip to 'true' once §6's numbers have been validated
// against real traffic.
function creditsEnforceFlag() {
  return process.env.AI_CREDITS_ENFORCE === 'true';
}
// Applied uniformly to every subject regardless of claimed Premium status — there is no
// server-verifiable entitlement yet (see src/routes/aiEntitlement.js's header comment), so
// pretending to grant Premium's larger allowance here would be trusting the same client-side
// signal this whole phase exists to stop trusting.
function monthlyCreditAllowance() {
  return Number(process.env.AI_MONTHLY_CREDIT_ALLOWANCE) || 15;
}
// The ONE limit that enforces unconditionally, no flag, from day one — a leaked
// CLIENT_SHARED_KEY draining the month's OpenAI/Gemini budget overnight is the catastrophic case
// this exists to stop (Plyndi-AI-Hub-Design.md §7's Phase 3 gate).
function dailyCreditCap() {
  return Number(process.env.AI_DAILY_CREDIT_CAP) || 2000;
}

// Logged loudly only once per UTC day the cap actually trips — a sustained overage would
// otherwise spam the log on every single rejected request afterward.
let capTripLoggedForDate = null;

function toResponse(run, extra = {}) {
  return {
    runId: run.runId,
    status: run.status,
    result: run.result,
    provider: run.provider,
    model: run.model,
    latencyMs: run.latencyMs,
    capabilityVersion: run.capabilityVersion,
    ...extra,
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

  // 4. who is calling (Phase 3-A, src/lib/subject.js) — device-scoped, never rejects for missing
  // identity while AI_REQUIRE_VERIFIED_IDENTITY is false (the default).
  const { subject, verified } = subjectLib.resolveSubject(req);

  // 5. idempotencyKey: a replay returns the stored run, never a second provider call or a second
  // credit charge — it short-circuits before either the spend cap or the allowance check below,
  // so replaying a request can never itself push either counter over its limit.
  if (idempotencyKey) {
    const existing = await store.findByIdempotency(subject, idempotencyKey);
    if (existing) {
      return res.status(200).json(toResponse(existing));
    }
  }

  // 6. GLOBAL DAILY SPEND CAP — checked BEFORE any provider call, summed across every subject.
  // This is the one limit that enforces unconditionally; a tripped cap costs nothing because the
  // provider is never reached.
  const dailyCap = dailyCreditCap();
  const spentToday = await store.globalSpendToday();
  if (spentToday + capability.creditCost > dailyCap) {
    const today = new Date().toISOString().slice(0, 10);
    if (capTripLoggedForDate !== today) {
      capTripLoggedForDate = today;
      console.error(
        `[ai/run] GLOBAL DAILY SPEND CAP REACHED (${spentToday}/${dailyCap} credits today) — ` +
        'refusing ALL /v1/ai/run requests until the UTC day rolls over. Raise AI_DAILY_CREDIT_CAP if this ' +
        'is expected traffic, or investigate for a leaked CLIENT_SHARED_KEY / abuse if it isn\'t.'
      );
    }
    return res.status(429).json({ error: 'daily_capacity_reached' });
  }

  // 7. per-subject monthly allowance — SHADOW MODE by default (see creditsEnforceFlag() above).
  const { periodStart, periodEnd } = currentBillingPeriod();
  const creditsUsedSoFar = await store.creditsUsed(subject, periodStart);
  const allowance = monthlyCreditAllowance();
  const wouldExceedAllowance = creditsUsedSoFar + capability.creditCost > allowance;
  if (wouldExceedAllowance) {
    if (creditsEnforceFlag()) {
      return res.status(402).json({
        error: 'credits_exhausted',
        creditsUsed: creditsUsedSoFar,
        creditsIncluded: allowance,
        creditsRemaining: Math.max(allowance - creditsUsedSoFar, 0),
        periodStart: periodStart.toISOString(),
        periodEnd: periodEnd.toISOString(),
      });
    }
    console.warn(
      `[ai/run] subject over its monthly allowance (${creditsUsedSoFar + capability.creditCost}/` +
      `${allowance} credits) but AI_CREDITS_ENFORCE is false — proceeding. ` +
      `capability=${capabilityId} verified=${verified}`
    );
  }

  // 8. render the prompt. Only {{context.<path>}} placeholders are substituted (see
  // renderPromptTemplate.js for the JSON-encoding/injection rationale); locale is exposed to the
  // template the same way by merging it onto a copy of the context, never onto the system prompt.
  const renderContext = { ...context, locale: locale ?? null };
  const userPrompt = renderPromptTemplate(capability.userPromptTemplate, renderContext);

  // 9. call the provider gateway directly — no HTTP loopback to /v1/generate (see
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

  // 10. parse and return the result; store the run. Validate ONLY that it parsed and is
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
    scopeKey: subject,
    verified,
  };
  await store.saveRun(run);
  // 11. debit the ledger AFTER a successful run — a failed/rejected run above never reaches here,
  // so nothing is ever charged for a run that didn't happen.
  await store.recordCredit({
    subject,
    verified,
    capabilityId,
    creditCost: capability.creditCost,
    runId: run.runId,
  });

  const creditsAfter = creditsUsedSoFar + capability.creditCost;
  return res.status(200).json(toResponse(run, {
    creditsRemaining: Math.max(allowance - creditsAfter, 0),
    creditsResetAt: periodEnd.toISOString(),
  }));
});

// GET /v1/ai/runs — insight feed / history, paginated, scoped to the caller's resolved subject
// (Phase 3-A; previously one coarse anonymous bucket shared by every caller — see git history).
router.get('/runs', async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
  const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : null;
  const { subject } = subjectLib.resolveSubject(req);
  const items = await store.listRuns(subject, limit, cursor);
  res.status(200).json({
    runs: items.map((run) => ({ ...toResponse(run), capabilityId: run.capabilityId, createdAt: new Date(run.createdAtMs).toISOString() })),
    nextCursor: items.length === limit ? items[items.length - 1].runId : null,
  });
});

module.exports = router;
