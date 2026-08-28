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

module.exports = router;
