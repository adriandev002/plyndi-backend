const express = require('express');
const router = express.Router();

// Same pass-through pattern as routes/gemini.js — forwards the OpenAI-shaped body
// (OpenAIClient.swift already builds this) straight to OpenAI's Chat Completions endpoint with
// the real key attached server-side instead of living in the app.
router.post('/chat/completions', async (req, res) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'OpenAI is not configured on this server.' });

  try {
    const upstream = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(req.body)
    });
    const data = await upstream.json();
    if (!upstream.ok) {
      console.error(`[openai] upstream ${upstream.status}`);
    }
    res.status(upstream.status).json(data);
  } catch (error) {
    console.error('[openai] request failed:', error.message);
    res.status(502).json({ error: 'OpenAI upstream request failed.' });
  }
});

module.exports = router;
