// Plain-Node test for GET /v1/admin/user-stats (the admin "Users" tab). Same style as
// scripts/test-home-banners.js — no framework, one in-process HTTP server, DATABASE_URL unset so
// only src/lib/store/memoryStore.js is exercised. Events are written straight into the store with
// chosen receivedAt times, so Taiwan-day boundaries can be tested exactly.
//
// Run: node scripts/test-user-stats.js

const http = require('http');

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail !== undefined ? ` — ${detail}` : ''}`);
  }
}
function assertEqual(label, actual, expected) {
  check(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

process.env.CLIENT_SHARED_KEY = 'test-shared-key';
delete process.env.DATABASE_URL;
delete process.env.ANALYTICS_EXCLUDE_DEVICE_IDS;
process.env.ADMIN_TOKEN = 'test-admin-token';

const app = require('../src/server');
const store = require('../src/lib/store');
const userStats = require('../src/lib/userStats');

function get(port, reqPath, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ port, path: reqPath, method: 'GET', headers }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch (_e) { /* not JSON */ }
        resolve({ status: res.statusCode, raw: text, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const DEV = {
  a: 'aaaaaaaa-0000-4000-8000-000000000001',
  b: 'bbbbbbbb-0000-4000-8000-000000000002',
  c: 'cccccccc-0000-4000-8000-000000000003',
  mine: 'dddddddd-0000-4000-8000-000000000004',
  tester: 'eeeeeeee-0000-4000-8000-000000000005',
  old: 'ffffffff-0000-4000-8000-000000000006',
};
const at = (iso) => new Date(iso);
const ev = (event, deviceId, iso, properties) => store.recordAnalyticsEvent({ event, deviceId, receivedAt: at(iso), properties });

async function main() {
  const port = await new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server.address().port));
  });
  const admin = { 'X-Admin-Token': 'test-admin-token' };
  const stats = (query) => get(port, `/v1/admin/user-stats${query || ''}`, admin);
  const day = (res, d) => (res.json.days || []).find((row) => row.day === d) || {};

  console.log('\n=== auth + validation ===');
  assertEqual('no admin token -> 401', (await get(port, '/v1/admin/user-stats', {})).status, 401);
  assertEqual('bad date -> 400', (await stats('?from=2026-13-01&to=2026-11-03')).status, 400);
  assertEqual('from after to -> 400', (await stats('?from=2026-11-05&to=2026-11-03')).status, 400);
  const empty = await stats('?from=2026-11-02&to=2026-11-03');
  check('empty store -> 200 with zero totals', empty.status === 200 && empty.json.totals.newInstalls === 0, empty.raw);
  assertEqual('every day in range is listed', (empty.json.days || []).length, 2);
  assertEqual('timezone reported', empty.json.timezone, 'Asia/Taipei');

  console.log('\n=== seeded launch data ===');
  // Device A: installs Nov 2 at 23:30 Taipei (15:30Z), reinstalls Nov 3 — counts ONCE, on Nov 2.
  await ev('onboarding_started', DEV.a, '2026-11-02T15:30:00Z');
  await ev('onboarding_completed', DEV.a, '2026-11-02T15:35:00Z');
  await ev('onboarding_started', DEV.a, '2026-11-03T02:00:00Z');
  await ev('onboarding_completed', DEV.a, '2026-11-03T02:05:00Z');
  await ev('user_activated', DEV.a, '2026-11-03T03:00:00Z');
  // Device B: 16:30Z on Nov 2 = 00:30 Nov 3 Taipei — a Taiwan-day boundary case.
  await ev('onboarding_started', DEV.b, '2026-11-02T16:30:00Z');
  await ev('trial_started', DEV.b, '2026-11-02T16:40:00Z');
  await ev('purchased', DEV.b, '2026-11-03T01:00:00Z');
  // Device C: mixed-case ID, Nov 3 Taipei.
  await ev('onboarding_started', DEV.c.toUpperCase(), '2026-11-03T05:00:00Z');
  // The owner's own phone — excluded via env var.
  await ev('onboarding_started', DEV.mine, '2026-11-02T10:00:00Z');
  await ev('user_activated', DEV.mine, '2026-11-02T10:10:00Z');
  // A TestFlight build — dropped by its build property.
  await ev('onboarding_started', DEV.tester, '2026-11-03T06:00:00Z', { build: 'testflight' });
  // A device that first installed BEFORE the range (a test run in October) — not a new install.
  await ev('onboarding_started', DEV.old, '2026-10-20T06:00:00Z');
  await ev('onboarding_started', DEV.old, '2026-11-03T06:00:00Z');
  // No device ID — can't be counted.
  await ev('onboarding_started', null, '2026-11-03T06:00:00Z');

  let res = await stats('?from=2026-11-02&to=2026-11-03');
  assertEqual('before exclusion: own phone counted on Nov 2', day(res, '2026-11-02').newInstalls, 2);

  process.env.ANALYTICS_EXCLUDE_DEVICE_IDS = ` ${DEV.mine.toUpperCase()} , unused-id `;
  res = await stats('?from=2026-11-02&to=2026-11-03');
  assertEqual('excludedDeviceCount', res.json.excludedDeviceCount, 2);
  assertEqual('Nov 2: only device A (own phone excluded, B is Nov 3 in Taiwan)', day(res, '2026-11-02').newInstalls, 1);
  assertEqual('Nov 3: B + C (reinstall of A, TestFlight, pre-range device, null ID all skipped)', day(res, '2026-11-03').newInstalls, 2);
  assertEqual('total new installs = 3', res.json.totals.newInstalls, 3);
  assertEqual('Nov 2 finished onboarding = 1 (A)', day(res, '2026-11-02').finishedOnboarding, 1);
  assertEqual('Nov 3 finished onboarding = 1 (A again)', day(res, '2026-11-03').finishedOnboarding, 1);
  assertEqual('total finished onboarding is distinct devices = 1', res.json.totals.finishedOnboarding, 1);
  assertEqual('activated = 1 (own phone excluded)', res.json.totals.activated, 1);
  assertEqual('trial counted on Nov 3 Taiwan time', day(res, '2026-11-03').trialsStarted, 1);
  assertEqual('purchases = 1', res.json.totals.purchases, 1);

  res = await stats('?from=2026-11-03&to=2026-11-03');
  assertEqual('Nov 3 only: A is not a new install (first install was Nov 2)', res.json.totals.newInstalls, 2);

  res = await stats('?from=2026-10-20&to=2026-10-20');
  assertEqual('Oct 20: the old device counts on its first day', res.json.totals.newInstalls, 1);

  console.log('\n=== helpers ===');
  assertEqual('taipeiDay crosses midnight at 16:00Z', userStats.taipeiDay(at('2026-11-02T16:00:00Z')), '2026-11-03');
  assertEqual('taipeiDay just before', userStats.taipeiDay(at('2026-11-02T15:59:59Z')), '2026-11-02');

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Test script crashed:', err);
  process.exit(1);
});
