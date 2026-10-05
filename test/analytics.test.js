// Contract tests for POST /v1/analytics/events (src/routes/analytics.js).
//
// The endpoint promises the app a 204 no matter what it sends — valid events are stored,
// anything malformed is dropped whole, and the client never sees a 4xx/5xx for a bad body.
// Run: node --test test/analytics.test.js  (also runs inside `npm test` via node --test test/)

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

async function waitForHealth(baseUrl, child) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Backend exited before health check');
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return;
    } catch (_error) {
      // Keep polling while the child starts.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Backend health check timed out');
}

test('analytics events endpoint always answers 204 and validates bodies', async (t) => {
  const port = 38900 + Math.floor(Math.random() * 500);
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(port), CLIENT_SHARED_KEY: 'test-client-key' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => {
    child.kill('SIGTERM');
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl, child);

  const url = `${baseUrl}/v1/analytics/events`;
  const headers = { 'content-type': 'application/json', 'X-Plyndi-Client-Key': 'test-client-key' };
  const post = (body, extraHeaders = {}) =>
    fetch(url, { method: 'POST', headers: { ...headers, ...extraHeaders }, body });

  // 1. A valid funnel event is accepted (204).
  const ok = await post(JSON.stringify({
    event: 'paywall_viewed',
    properties: { source: 'profile' },
    deviceId: '123e4567-e89b-12d3-a456-426614174000',
  }));
  assert.equal(ok.status, 204);

  // 2. Unknown event names are dropped whole — still 204, never a 4xx.
  const unknown = await post(JSON.stringify({ event: 'not_a_real_event' }));
  assert.equal(unknown.status, 204);

  // 3. Non-string / oversized properties are dropped whole — still 204.
  const badProps = await post(JSON.stringify({
    event: 'trial_started',
    properties: { product_id: 12345 },
  }));
  assert.equal(badProps.status, 204);

  const tooMany = await post(JSON.stringify({
    event: 'purchased',
    properties: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, 'v'])),
  }));
  assert.equal(tooMany.status, 204);

  // 4. Malformed JSON never becomes a 500 — src/server.js turns it into a 204 for this path.
  const malformed = await post('{"event": "paywall_viewed",');
  assert.equal(malformed.status, 204);

  // 5. Missing client key is still rejected — the endpoint sits behind requireClientKey.
  const noKey = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event: 'paywall_viewed' }),
  });
  assert.equal(noKey.status, 401);
});

test('memory store records analytics events', async () => {
  // In-process check of the store surface the route calls (no DATABASE_URL here, so this
  // is the memory adapter — the spawned-server test above covers the HTTP contract).
  const store = require('../src/lib/store');
  assert.equal(typeof store.recordAnalyticsEvent, 'function');
  const id = await store.recordAnalyticsEvent({
    event: 'trial_started',
    properties: { product_id: 'com.axel.Plyndi.Plyndi.premium.yearly' },
    deviceId: 'test-device',
    receivedAt: new Date(),
  });
  assert.ok(Number.isInteger(id) && id >= 1);
  if (typeof store._resetForTests === 'function') store._resetForTests();
});
