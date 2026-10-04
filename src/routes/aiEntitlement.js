// ============================================================================
// GET /v1/ai/entitlement — Plyndi-AI-Hub-Design.md §4.1, Phase 3-A/3-B.
// ----------------------------------------------------------------------------
// Reports what the SERVER knows about the caller's credits — never what the client claims
// about its own Premium status. `plan` comes from src/lib/entitlement.js's resolvePlan(),
// the same function POST /v1/ai/run enforces with, so the meter this endpoint reports and
// the enforcement aiRun.js applies can never drift apart: 'premium' only while a
// cryptographically verified, unexpired, unrevoked StoreKit 2 entitlement exists for this
// subject; everything else is 'free'. (Phase 3-A's "always unknown" is superseded — the
// server-verifiable entitlement that phase explicitly deferred now exists.)
//
// Credits ship in SHADOW MODE (Plyndi-AI-Hub-Design.md §6) until AI_CREDITS_ENFORCE flips:
// `enforcing` mirrors the flag so the app can render an honest meter, but nothing here
// refuses anything — POST /v1/ai/run is the only place enforcement actually happens.
// ============================================================================
//
// POST /v1/ai/entitlement/verify — Phase 3-B, the write side of the same trust story.
// ----------------------------------------------------------------------------
// The app POSTs { signedTransaction } — a StoreKit 2 transaction's `jwsRepresentation`
// (StoreKitManager.refreshEntitlements, taken from Transaction.currentEntitlements) — with
// the SAME identity headers as /v1/ai/run, so the entitlement lands on the same subject
// the credit ledger uses. verifySignedTransaction() cryptographically verifies the JWS
// (Apple Root CA - G3 chain, ES256 signature, bundleId, productId, expiry, revocation);
// only then is the entitlement stored via store.saveEntitlement. ANY failure -> 422, nothing
// stored, plan stays 'free' (fail closed).
//
// MOUNTING MATTERS — read before moving this: src/server.js mounts verifyRouter AHEAD of
// the sanitizeBody middleware. sanitizeBody redacts PII-looking digit runs out of every
// request-body string, and a JWS is base64 that can contain exactly such runs — letting it
// through would corrupt the signature before verification sees it. The client-key check and
// the rate limiter still apply (it's mounted after both), only the PII scrubber is skipped,
// which is safe: a JWS carries no PII, only Apple's signature over a transaction.
// ============================================================================

const express = require('express');
const router = express.Router();
// Mounted separately in src/server.js (see above) — same trust boundary, different
// middleware position.
const verifyRouter = express.Router();

const store = require('../lib/store');
const subjectLib = require('../lib/subject');
const { currentBillingPeriod } = require('../lib/billingPeriod');
const {
  resolvePlan,
  verifySignedTransaction,
  EntitlementVerificationError,
} = require('../lib/entitlement');

// Read fresh from process.env on every request, same reasoning as src/routes/aiRun.js's
// creditsEnforceFlag() — and the allowance itself comes from resolvePlan(), the identical
// function aiRun.js enforces with, so meter and enforcement share one definition of each
// tier. Exercised by scripts/test-ai-credits.js without a process restart.
router.get('/', async (req, res, next) => {
  try {
    const { subject } = subjectLib.resolveSubject(req);
    const plan = await resolvePlan(subject, store);
    const { periodStart, periodEnd } = currentBillingPeriod();
    const creditsUsed = await store.creditsUsed(subject, periodStart);

    res.set('Cache-Control', 'no-store');
    res.status(200).json({
      plan: plan.plan,
      creditsIncluded: plan.allowance,
      creditsUsed,
      creditsRemaining: Math.max(plan.allowance - creditsUsed, 0),
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      enforcing: process.env.AI_CREDITS_ENFORCE === 'true',
      // Lets the app show "Premium until <date>" honestly; absent for free.
      ...(plan.entitlement && plan.entitlement.expiresAtMs != null
        ? { entitlementExpiresAt: new Date(plan.entitlement.expiresAtMs).toISOString() }
        : {}),
    });
  } catch (err) {
    next(err);
  }
});

verifyRouter.post('/', async (req, res, next) => {
  try {
    const { signedTransaction } = req.body || {};
    if (typeof signedTransaction !== 'string' || !signedTransaction) {
      return res.status(400).json({ error: 'invalid_request' });
    }
    const { subject } = subjectLib.resolveSubject(req);

    let verified;
    try {
      verified = verifySignedTransaction(signedTransaction);
    } catch (err) {
      if (err instanceof EntitlementVerificationError) {
        // Fail closed: nothing stored, plan stays 'free'. The stable `reason` code is safe
        // to surface — it names which check failed, never any key material.
        console.warn(`[ai/entitlement/verify] rejected JWS for subject ${subject}: ${err.code}`);
        return res.status(422).json({ error: 'entitlement_unverified', reason: err.code });
      }
      throw err;
    }

    await store.saveEntitlement(subject, {
      productId: verified.productId,
      originalTransactionId: verified.originalTransactionId,
      expiresAtMs: verified.expiresAtMs,
      bundleId: verified.bundleId,
    });
    return res.status(200).json({
      ok: true,
      plan: 'premium',
      productId: verified.productId,
      expiresAt: verified.expiresAtMs != null ? new Date(verified.expiresAtMs).toISOString() : null,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.verifyRouter = verifyRouter;
