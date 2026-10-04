// ============================================================================
// Server-verifiable Premium entitlement (Phase 3-B).
// ----------------------------------------------------------------------------
// The problem this closes: `AuthManager.isPremium` is a client-side UserDefaults boolean.
// aiRun.js used to say it plainly — with no server-verifiable entitlement, granting Premium's
// larger credit allowance would have meant trusting a client-controlled signal, so everyone
// shared one allowance. This module is the other half of that fix.
//
// Flow:
//   1. The app (StoreKitManager.refreshEntitlements) finds a verified Premium transaction in
//      StoreKit 2's Transaction.currentEntitlements and takes its `jwsRepresentation` — a JWS
//      whose x5c header carries Apple's certificate chain for that transaction.
//   2. The app POSTs that JWS to /v1/ai/entitlement/verify, with the SAME identity headers as
//      /v1/ai/run, so the entitlement lands on the same subject the credit ledger uses
//      (src/lib/subject.js — verified JWT sub, dev:<device-id>, or anon:<hashed-ip>).
//   3. verifySignedTransaction() checks, in order: the x5c chain anchors at Apple's Root
//      CA - G3 (bundled as appleRootCA-G3.pem next to this file), the JWS signature is valid
//      ES256 by the chain's leaf key, bundleId matches this app, productId is a Plyndi
//      Premium product, and the transaction is neither expired nor revoked.
//   4. On success the entitlement is stored (store.saveEntitlement); on ANY failure nothing
//      is stored and the caller fails closed to the free allowance.
//
// Why local verification instead of the App Store Server API: that API needs an App Store
// Connect API key (issuer ID + key ID + private key), which requires paid Developer Program
// membership. Local JWS verification needs only Apple's PUBLIC root certificate — no account,
// no secret — so it works the day the first real subscription exists.
//
// Fail-closed everywhere: an unverifiable JWS -> 422, no row written, plan stays 'free'. A
// legitimate Premium user whose JWS fails verification degrades to the free allowance until
// the next successful sync — annoying, never a hole.
//
// No new npm dependencies: X.509 parsing via crypto.X509Certificate and ECDSA via
// crypto.verify (dsaEncoding ieee-p1363 for JWS's raw R||S) are all Node built-ins.
// ============================================================================

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Configuration — every knob is env-overridable and read fresh (not cached at module
// load), the same convention aiRun.js uses for AI_CREDITS_ENFORCE, so tests can flip tiers
// mid-run against one already-listening server.
// ---------------------------------------------------------------------------

// Plyndi Premium product IDs. Must match PlyndiProductID in the iOS app's
// StoreKitManager.swift exactly.
function premiumProductIds() {
  const raw = process.env.PLYNDI_PREMIUM_PRODUCT_IDS || '';
  const ids = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return ids.length ? ids : [
    'com.axel.Plyndi.Plyndi.premium.monthly',
    'com.axel.Plyndi.Plyndi.premium.yearly',
  ];
}

function expectedBundleId() {
  return process.env.PLYNDI_BUNDLE_ID || 'com.axel.Plyndi.Plyndi';
}

// AI_FREE_MONTHLY_ALLOWANCE falls back to the legacy AI_MONTHLY_CREDIT_ALLOWANCE so an
// existing deploy that only sets the old var keeps its current free-tier behaviour with no
// config change.
function freeAllowance() {
  return Number(process.env.AI_FREE_MONTHLY_ALLOWANCE)
    || Number(process.env.AI_MONTHLY_CREDIT_ALLOWANCE)
    || 15;
}

function premiumAllowance() {
  return Number(process.env.AI_PREMIUM_MONTHLY_ALLOWANCE) || 300;
}

// ---------------------------------------------------------------------------
// Errors — `code` is the stable machine-readable reason the route surfaces as
// `reason` in its 422 body; the human-readable message stays server-side in logs.
// ---------------------------------------------------------------------------
class EntitlementVerificationError extends Error {
  constructor(code, detail) {
    super(`entitlement verification failed: ${code}${detail ? ` (${detail})` : ''}`);
    this.name = 'EntitlementVerificationError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Trust anchors — Apple's Root CA - G3, bundled as PEM next to this file (downloaded from
// https://www.apple.com/certificateauthority/ ; SHA-256 fingerprint
// 63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79).
// ENTITLEMENT_TRUSTED_ROOT_PEM_PATH overrides the bundle with another PEM file — the test
// suite's escape hatch (it generates its own CA chain with openssl and points here), and a
// no-code-change recovery path if Apple ever rotates the root before this file is updated.
// Cached per resolved path, so mid-run env flips in tests take effect.
// ---------------------------------------------------------------------------
const rootCache = new Map(); // pemPath -> crypto.X509Certificate[]

function trustedRootCerts() {
  const pemPath = process.env.ENTITLEMENT_TRUSTED_ROOT_PEM_PATH
    || path.join(__dirname, 'appleRootCA-G3.pem');
  if (!rootCache.has(pemPath)) {
    let pem;
    try {
      pem = fs.readFileSync(pemPath, 'utf8');
    } catch (err) {
      throw new EntitlementVerificationError('untrusted_chain', `cannot read trust anchor ${pemPath}`);
    }
    const blocks = pem.match(/-----BEGIN CERTIFICATE-----[^-]*-----END CERTIFICATE-----/g) || [];
    const certs = [];
    for (const block of blocks) {
      try {
        certs.push(new crypto.X509Certificate(block));
      } catch (_e) { /* skip an unparseable block; emptiness is checked below */ }
    }
    if (!certs.length) {
      throw new EntitlementVerificationError('untrusted_chain', `no parseable certificate in ${pemPath}`);
    }
    rootCache.set(pemPath, certs);
  }
  return rootCache.get(pemPath);
}

// ---------------------------------------------------------------------------
// verifyChain(x5c) -> leaf X509Certificate. Throws EntitlementVerificationError.
// x5c is the JWS header's base64-DER certificate array, leaf first.
// ---------------------------------------------------------------------------
function verifyChain(x5c) {
  if (!Array.isArray(x5c) || x5c.length === 0) {
    throw new EntitlementVerificationError('untrusted_chain', 'empty or missing x5c');
  }
  let certs;
  try {
    certs = x5c.map((b64) => new crypto.X509Certificate(Buffer.from(String(b64), 'base64')));
  } catch (_e) {
    throw new EntitlementVerificationError('untrusted_chain', 'x5c entry is not a parseable certificate');
  }

  const now = Date.now();
  for (const cert of certs) {
    const notBefore = Date.parse(cert.validFrom);
    const notAfter = Date.parse(cert.validTo);
    if (!(notBefore <= now && now <= notAfter)) {
      throw new EntitlementVerificationError('untrusted_chain', 'certificate outside its validity period');
    }
  }

  // Every certificate must be signed by the next one in the array (issuer/subject name
  // match first — cheap — then the actual cryptographic signature).
  for (let i = 0; i < certs.length - 1; i += 1) {
    if (certs[i].issuer !== certs[i + 1].subject) {
      throw new EntitlementVerificationError('untrusted_chain', 'issuer/subject name mismatch in chain');
    }
    let sigOk = false;
    try {
      sigOk = certs[i].verify(certs[i + 1].publicKey);
    } catch (_e) { sigOk = false; }
    if (!sigOk) {
      throw new EntitlementVerificationError('untrusted_chain', 'chain signature invalid');
    }
  }

  // The tail of the presented chain must anchor at a pinned root. (If Apple includes the
  // root itself in x5c, this is a self-signature check against the identical pinned cert —
  // still correct.)
  const tail = certs[certs.length - 1];
  const anchored = trustedRootCerts().some((root) => {
    if (tail.fingerprint256 === root.fingerprint256) return true;
    try {
      return tail.verify(root.publicKey);
    } catch (_e) { return false; }
  });
  if (!anchored) {
    throw new EntitlementVerificationError('untrusted_chain', 'chain does not anchor at a trusted Apple root');
  }
  return certs[0];
}

// ---------------------------------------------------------------------------
// verifySignedTransaction(jws) -> { transactionId, originalTransactionId, productId,
// bundleId, environment, expiresAtMs }. Throws EntitlementVerificationError on anything
// untrustworthy — malformed JWS, untrusted chain, bad signature, wrong bundle/product,
// expired, or revoked.
// ---------------------------------------------------------------------------
function verifySignedTransaction(jws) {
  if (typeof jws !== 'string' || !jws) {
    throw new EntitlementVerificationError('malformed_jws', 'not a non-empty string');
  }
  const parts = jws.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new EntitlementVerificationError('malformed_jws', 'expected header.payload.signature');
  }

  let header;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  } catch (_e) {
    throw new EntitlementVerificationError('malformed_jws', 'header is not JSON');
  }
  if (!header || header.alg !== 'ES256') {
    throw new EntitlementVerificationError('malformed_jws', `unexpected alg ${header && header.alg}`);
  }

  const leaf = verifyChain(header.x5c);

  // JWS ES256: ECDSA P-256 over ASCII(header_b64 + '.' + payload_b64), signature is raw
  // R||S (64 bytes) — hence dsaEncoding ieee-p1363 rather than Node's DER default.
  const signingInput = `${parts[0]}.${parts[1]}`;
  const signature = Buffer.from(parts[2], 'base64url');
  let signatureOk = false;
  try {
    signatureOk = crypto.verify(
      'sha256',
      Buffer.from(signingInput, 'utf8'),
      { key: leaf.publicKey, dsaEncoding: 'ieee-p1363' },
      signature
    );
  } catch (_e) { signatureOk = false; }
  if (!signatureOk) {
    throw new EntitlementVerificationError('bad_signature');
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch (_e) {
    throw new EntitlementVerificationError('malformed_jws', 'payload is not JSON');
  }
  if (!payload || typeof payload !== 'object') {
    throw new EntitlementVerificationError('malformed_jws', 'payload is not an object');
  }

  const bundleId = expectedBundleId();
  if (payload.bundleId !== bundleId) {
    throw new EntitlementVerificationError('wrong_bundle', `got ${payload.bundleId}`);
  }
  const productIds = premiumProductIds();
  if (!productIds.includes(payload.productId)) {
    throw new EntitlementVerificationError('unknown_product', `got ${payload.productId}`);
  }
  if (payload.revocationDate != null) {
    throw new EntitlementVerificationError('revoked');
  }
  // Apple's StoreKit dates are ms since epoch (numbers; occasionally numeric strings).
  // Absent expiresDate = a non-expiring entitlement (not our subscription products today,
  // but the check stays general rather than assuming).
  const expiresAtMs = payload.expiresDate != null ? Number(payload.expiresDate) : null;
  if (expiresAtMs != null && !(expiresAtMs > Date.now())) {
    throw new EntitlementVerificationError('expired');
  }

  return {
    transactionId: String(payload.transactionId || ''),
    originalTransactionId: String(payload.originalTransactionId || payload.transactionId || ''),
    productId: payload.productId,
    bundleId: payload.bundleId,
    environment: payload.environment || null,
    expiresAtMs,
  };
}

// ---------------------------------------------------------------------------
// resolvePlan(subject, store) -> { plan: 'free'|'premium', allowance, entitlement|null }.
//
// THE single place a subject's plan is decided — both POST /v1/ai/run (enforcement) and
// GET /v1/ai/entitlement (the meter the app renders) call this, so the meter and the
// enforcement can never disagree. 'premium' requires a stored, unexpired, unrevoked
// entitlement that only verifySignedTransaction() could have written — never anything the
// client claims about itself. Fails closed to 'free' on any store error.
// ---------------------------------------------------------------------------
async function resolvePlan(subject, store) {
  const free = { plan: 'free', allowance: freeAllowance(), entitlement: null };
  let ent = null;
  try {
    ent = await store.getEntitlement(subject);
  } catch (err) {
    console.error(`[entitlement] getEntitlement failed — failing closed to free plan: ${err.message}`);
    return free;
  }
  if (!ent) return free;
  if (ent.revokedAtMs != null) return free;
  if (ent.expiresAtMs != null && !(ent.expiresAtMs > Date.now())) return free;
  return { plan: 'premium', allowance: premiumAllowance(), entitlement: ent };
}

module.exports = {
  EntitlementVerificationError,
  verifySignedTransaction,
  resolvePlan,
  premiumProductIds,
  freeAllowance,
  premiumAllowance,
};
