const express = require('express');
const router = express.Router();

// Pure pass-through proxy: the app sends exactly the body it would have sent straight to
// Google (contents/generationConfig/etc — the same shape GeminiClient.swift already builds),
// this just injects the real key server-side and forwards it. Nothing about Gemini's own
// request/response shape is reinterpreted here — pointing the app at this URL instead of
// Google's is the whole client-side change the next step needs to make; no request-building
// logic needs to move.
router.post('/:model/generate', async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Gemini is not configured on this server.' });

  const { model } = req.params;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`;

  try {
    const upstream = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    });
    const data = await upstream.json();
    if (!upstream.ok) {
      console.error(`[gemini] upstream ${upstream.status} for model ${model}`);
    }
    res.status(upstream.status).json(data);
  } catch (error) {
    console.error('[gemini] request failed:', error.message);
    res.status(502).json({ error: 'Gemini upstream request failed.' });
  }
});

module.exports = router;
