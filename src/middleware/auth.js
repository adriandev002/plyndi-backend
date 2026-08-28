// Every request past this middleware (mounted after /healthz, which stays open for Render's own
// health monitor) must carry the same shared secret both the iOS and Android app builds embed —
// see .env.example's CLIENT_SHARED_KEY.
//
// This is deliberately NOT per-user auth: it doesn't identify who's calling, only that the
// caller is a real Plyndi app build and not a stranger who found this URL. That's enough to stop
// casual scraping/abuse of an endpoint that spends real OpenAI/Gemini/Places money on every
// call — it is NOT tamper-proof, since anyone who decompiles the app binary can recover the key.
// If usage ever needs to survive that threat model, the natural upgrade is App Attest (iOS) /
// Play Integrity (Android) — verifying the request came from an unmodified, genuine app install
// rather than trusting a shared string. Worth revisiting once this ships broadly; not needed for
// the first real deployment.
module.exports = function requireClientKey(req, res, next) {
  const expected = process.env.CLIENT_SHARED_KEY;
  if (!expected) {
    console.error('[auth] CLIENT_SHARED_KEY is not set on the server — refusing all requests.');
    return res.status(500).json({ error: 'Server misconfigured.' });
  }
  const provided = req.get('X-Plyndi-Client-Key');
  if (provided !== expected) {
    return res.status(401).json({ error: 'Missing or invalid client key.' });
  }
  next();
};
