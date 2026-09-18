// Minimal HS256 JWT verifier, lifted verbatim out of src/routes/sync.js (Phase 3-A,
// Plyndi-AI-Hub-Design.md §4.5) so /v1/ai/run's new subject resolution (src/lib/subject.js) can
// reuse the exact same verification logic and subject-format rule instead of a second
// hand-rolled JWT parser. /v1/sync's own behaviour is unchanged — it now calls through this
// module rather than defining the logic inline, byte-identical otherwise.
//
// Deliberately not a general-purpose JWT library: this only ever needs to check one algorithm
// (HS256), one claim (`sub`), and one optional expiry (`exp`) — the same minimal surface
// providerGateway.js's own header comment argues for regarding jsonSchemaLite.js.

const crypto = require('crypto');

// A verified subject (JWT `sub`, or the X-Plyndi-Device-ID / X-Plyndi-User-ID header value it's
// compared against elsewhere) must match this shape: starts with an alphanumeric, then up to 127
// more alphanumerics/`.`/`_`/`-`. Shared so every caller enforces the identical rule.
const SUBJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function base64UrlDecode(value) {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

// Verifies an HS256-signed JWT's signature and expiry against `secret`, and returns its `sub`
// claim ONLY if every check passes and `sub` matches SUBJECT_PATTERN. Returns null on any
// failure — no secret configured, malformed token, wrong alg/typ, bad signature, expired, or a
// `sub` outside the allowed character set. Never throws.
function verifyHs256Subject(token, secret) {
  if (!secret || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  let header;
  let payload;
  try {
    header = JSON.parse(base64UrlDecode(parts[0]).toString('utf8'));
    payload = JSON.parse(base64UrlDecode(parts[1]).toString('utf8'));
  } catch (_error) {
    return null;
  }
  if (header.alg !== 'HS256' || header.typ !== 'JWT' || typeof payload.sub !== 'string') return null;
  const expected = crypto.createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest();
  const provided = base64UrlDecode(parts[2]);
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) return null;
  if (payload.exp !== undefined && (!Number.isFinite(payload.exp) || payload.exp <= Math.floor(Date.now() / 1000))) return null;
  if (!SUBJECT_PATTERN.test(payload.sub)) return null;
  return payload.sub;
}

module.exports = { verifyHs256Subject, SUBJECT_PATTERN };
