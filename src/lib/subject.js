// Who is calling POST /v1/ai/run (Plyndi-AI-Hub-Design.md §4.5, Phase 3-A) — device-scoped, not
// per-account. Read Plyndi-AI-Hub-Design.md's "Identity reality" note before touching this file:
// the app links only FirebaseAI (no Firebase Auth, no Firebase uid), sign-in is on-device Apple/
// Google, `AuthManager.isPremium` is a client UserDefaults boolean, and — critically — shipped
// builds send NO Authorization header today. Breaking a request that sends none breaks every
// installed copy of the app with no fix but an App Store release.
//
// Resolution order, most confident first. This NEVER throws and NEVER returns without a usable
// subject — even a request with zero identity headers gets one, because AI_REQUIRE_VERIFIED_IDENTITY
// defaults to false (see below).
//
//   1. a verified HS256 bearer token (same verifier /v1/sync already uses — src/lib/hs256Subject.js)
//        -> { subject: <sub>, verified: true }
//   2. X-Plyndi-Device-ID (a stable Keychain-backed UUID the app will send starting Phase 3-B),
//      matching the same subject-format rule as a JWT's `sub`
//        -> { subject: 'dev:'+id, verified: false }
//   3. neither -> a coarse fallback so at least all requests from one caller share a bucket
//        -> { subject: 'anon:'+hash(ip), verified: false }
//
// `verified` is stored on every run and ledger row (src/lib/store/*) precisely so a future real
// account system can tell genuine verified subjects apart from device ids without a data
// migration — nothing today infers Premium or any other entitlement from it.

const crypto = require('crypto');
const { verifyHs256Subject, SUBJECT_PATTERN } = require('./hs256Subject');

const AI_JWT_SECRET = process.env.AI_JWT_SECRET || '';

// Mirrors SYNC_REQUIRE_VERIFIED_IDENTITY's naming, but the DEFAULT is the opposite of sync's:
// lenient (false), not strict. Sync's callers are the user's own encrypted backups, worth
// refusing without a real identity; the AI Hub is a Premium retention surface with builds already
// in the wild sending nothing, and this repo's anti-goal list is explicit: do not require auth,
// and do not break a request that sends none. Flipping this to 'true' is a future step for once a
// real, server-verifiable account system exists — nothing in Phase 3-A exercises that path.
const REQUIRE_VERIFIED_IDENTITY = process.env.AI_REQUIRE_VERIFIED_IDENTITY === 'true';

function hashSubjectFromIp(ip) {
  return crypto.createHash('sha256').update(String(ip || 'unknown')).digest('hex').slice(0, 24);
}

function resolveSubject(req) {
  const authorization = req.get('Authorization') || '';
  const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  const verifiedSubject = verifyHs256Subject(bearer, AI_JWT_SECRET);
  if (verifiedSubject) {
    return { subject: verifiedSubject, verified: true, source: 'jwt' };
  }

  const deviceId = req.get('X-Plyndi-Device-ID');
  if (typeof deviceId === 'string' && SUBJECT_PATTERN.test(deviceId)) {
    return { subject: `dev:${deviceId}`, verified: false, source: 'device' };
  }

  return { subject: `anon:${hashSubjectFromIp(req.ip)}`, verified: false, source: 'anon' };
}

module.exports = { resolveSubject, REQUIRE_VERIFIED_IDENTITY };
