// ============================================================================
// GET /v1/ai/entitlement — Plyndi-AI-Hub-Design.md §4.1, Phase 3-A.
// ----------------------------------------------------------------------------
// Reports what the SERVER knows about the caller's credits — never what the client claims about
// its own Premium status. Per Plyndi-AI-Hub-Design.md's "Identity reality" note: the app has no
// Firebase Auth and `AuthManager.isPremium` is a client-side UserDefaults boolean, not a
// server-verifiable fact. Real entitlement requires server-side StoreKit receipt validation,
// which does NOT exist yet — that is explicitly out of scope for this phase. `plan` is therefore
// always "unknown"; do not infer Premium from anything the client sends, ever.
//
// Credits ship in SHADOW MODE (Plyndi-AI-Hub-Design.md §6): `enforcing` mirrors
// AI_CREDITS_ENFORCE so the app can render an honest meter, but nothing here refuses anything —
// POST /v1/ai/run is the only place enforcement (when the flag is on) actually happens.
// ============================================================================

const express = require('express');
const router = express.Router();

const store = require('../lib/store');
const subjectLib = require('../lib/subject');
const { currentBillingPeriod } = require('../lib/billingPeriod');

// Read fresh from process.env on every request, same reasoning as src/routes/aiRun.js's
// creditsEnforceFlag()/monthlyCreditAllowance() — kept identical by reading the SAME env vars, so
// the meter this endpoint reports and the enforcement aiRun.js actually applies can never drift
// apart, and both are exercised by scripts/test-ai-credits.js without a process restart.
router.get('/', async (req, res, next) => {
  try {
    const allowance = Number(process.env.AI_MONTHLY_CREDIT_ALLOWANCE) || 15;
    const { subject } = subjectLib.resolveSubject(req);
    const { periodStart, periodEnd } = currentBillingPeriod();
    const creditsUsed = await store.creditsUsed(subject, periodStart);

    res.set('Cache-Control', 'no-store');
    res.status(200).json({
      plan: 'unknown',
      creditsIncluded: allowance,
      creditsUsed,
      creditsRemaining: Math.max(allowance - creditsUsed, 0),
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      enforcing: process.env.AI_CREDITS_ENFORCE === 'true',
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
