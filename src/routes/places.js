const express = require('express');
const router = express.Router();

// Google Places API (New) uses POST + a JSON body for both Autocomplete and text search, unlike
// the older Places API's query-string GETs — matches what SettingsView.swift's footer already
// says the app is built against ("Places API (New)"). Same pass-through pattern as the AI
// routes: forward the body, inject the real key as a header, return the upstream response as-is.
router.post('/autocomplete', (req, res) => proxyPlaces(req, res, 'https://places.googleapis.com/v1/places:autocomplete'));
router.post('/search', (req, res) => proxyPlaces(req, res, 'https://places.googleapis.com/v1/places:searchText'));

async function proxyPlaces(req, res, url) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Places is not configured on this server.' });

  try {
    const upstream = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        // Places API (New) requires an explicit field mask on every request. The app can send
        // its own via the same header for a narrower/wider result; this default just keeps a
        // request with no opinion on the header from being rejected outright.
        'X-Goog-FieldMask': req.get('X-Goog-FieldMask') || '*'
      },
      body: JSON.stringify(req.body)
    });
    const data = await upstream.json();
    if (!upstream.ok) {
      console.error(`[places] upstream ${upstream.status}`);
    }
    res.status(upstream.status).json(data);
  } catch (error) {
    console.error('[places] request failed:', error.message);
    res.status(502).json({ error: 'Places upstream request failed.' });
  }
}

// ---------------------------------------------------------------------------
// Place photo proxy — GET /v1/places/photo?name=places/<id>/photos/<ref>&maxWidthPx=400
//
// Google's photo media endpoint needs the API key, and the iOS app has no key of its own in
// release builds (the on-device key was a dev-only Settings field, stored in the Keychain, so it
// vanished with the com.plyndi.app bundle-ID change). The app now fetches photo BYTES through
// here: the server asks Google for the short-lived photo URI (skipHttpRedirect=true), downloads
// the image and returns it with a long cache lifetime. The app also caches it on disk.
//
// Mounted in src/server.js after requireClientKey but AHEAD of the general 60-an-hour limiter,
// with its own limiter, because one trip screen can request a dozen thumbnails at once.
// ---------------------------------------------------------------------------
const rateLimit = require('express-rate-limit');

const PHOTO_NAME_PATTERN = /^places\/[A-Za-z0-9_-]+\/photos\/[A-Za-z0-9_-]+$/;

const photoLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.PLACES_PHOTO_RATE_LIMIT_MAX) || 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' }
});

const photoRouter = express.Router();
photoRouter.get('/', photoLimiter, async (req, res) => {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Places is not configured on this server.' });

  const name = String(req.query.name || '');
  if (!PHOTO_NAME_PATTERN.test(name)) return res.status(400).json({ error: 'Invalid photo name.' });
  const width = Math.min(Math.max(parseInt(req.query.maxWidthPx, 10) || 400, 64), 1600);

  try {
    const metaURL = `https://places.googleapis.com/v1/${name}/media?maxWidthPx=${width}&skipHttpRedirect=true`;
    const meta = await fetch(metaURL, { headers: { 'X-Goog-Api-Key': apiKey } });
    if (!meta.ok) {
      console.error(`[places/photo] media lookup upstream ${meta.status}`);
      return res.status(meta.status === 404 ? 404 : 502).json({ error: 'Photo unavailable.' });
    }
    const { photoUri } = await meta.json();
    if (!photoUri || !/^https:\/\//.test(photoUri)) return res.status(502).json({ error: 'Photo unavailable.' });

    const image = await fetch(photoUri);
    if (!image.ok) {
      console.error(`[places/photo] image upstream ${image.status}`);
      return res.status(502).json({ error: 'Photo unavailable.' });
    }
    const bytes = Buffer.from(await image.arrayBuffer());
    res.set('Content-Type', image.headers.get('content-type') || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(bytes);
  } catch (error) {
    console.error('[places/photo] request failed:', error.message);
    res.status(502).json({ error: 'Places upstream request failed.' });
  }
});

module.exports = router;
module.exports.photoRouter = photoRouter;
