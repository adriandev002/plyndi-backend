// Contract tests for GET /v1/places/photo (src/routes/places.js photoRouter).
// Google is stubbed via global.fetch, so no real key or network is needed.
// Run: node --test test/placesPhoto.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

process.env.GOOGLE_PLACES_API_KEY = 'test-key';
const { photoRouter } = require('../src/routes/places');

const realFetch = global.fetch;
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

function start() {
  const app = express();
  app.use('/v1/places/photo', photoRouter);
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

test('returns image bytes for a valid photo name', async () => {
  const calls = [];
  const { server, base } = await start();
  global.fetch = async (url, opts) => {
    if (String(url).startsWith(base)) return realFetch(url, opts);
    calls.push({ url: String(url), opts });
    if (String(url).includes('/media?')) return new Response(JSON.stringify({ photoUri: 'https://lh3.example/img' }), { status: 200 });
    return new Response(JPEG, { status: 200, headers: { 'content-type': 'image/jpeg' } });
  };
  try {
    const res = await realFetch(`${base}/v1/places/photo?name=places/ChIJabc/photos/Aa-x_1&maxWidthPx=99999`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/jpeg');
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), JPEG);
    assert.match(calls[0].url, /maxWidthPx=1600&skipHttpRedirect=true/);
    assert.equal(calls[0].opts.headers['X-Goog-Api-Key'], 'test-key');
  } finally { global.fetch = realFetch; server.close(); }
});

test('rejects malformed photo names without calling Google', async () => {
  const { server, base } = await start();
  let called = false;
  global.fetch = async (url, opts) => { if (String(url).startsWith(base)) return realFetch(url, opts); called = true; };
  try {
    for (const bad of ['../etc/passwd', 'places/a/photos/b/../c', 'https://evil', '']) {
      const res = await realFetch(`${base}/v1/places/photo?name=${encodeURIComponent(bad)}`);
      assert.equal(res.status, 400);
    }
    assert.equal(called, false);
  } finally { global.fetch = realFetch; server.close(); }
});

test('upstream failure maps to 502', async () => {
  const { server, base } = await start();
  global.fetch = async (url, opts) => String(url).startsWith(base) ? realFetch(url, opts) : new Response('{}', { status: 403 });
  try {
    const res = await realFetch(`${base}/v1/places/photo?name=places/A/photos/B`);
    assert.equal(res.status, 502);
  } finally { global.fetch = realFetch; server.close(); }
});
