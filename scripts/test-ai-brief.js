// Plain-Node smoke test for Phase 4-A: the Daily Brief (POST /v1/ai/brief/digest,
// GET /v1/ai/brief — src/routes/aiBrief.js). Same no-framework style as scripts/test-ai-credits.js:
// one in-process HTTP server, the provider layer stubbed, run entirely against the in-memory store
// (DATABASE_URL is explicitly deleted — this environment can't reach a real Postgres, and a suite
// that spends real money per run would be a bad suite regardless).
//
// Run: node scripts/test-ai-brief.js

const http = require('http');
const fs = require('fs');
const path = require('path');

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

const CLIENT_KEY = 'test-shared-key';
process.env.CLIENT_SHARED_KEY = CLIENT_KEY;
process.env.AI_DAILY_CREDIT_CAP = '1000';
process.env.AI_MONTHLY_CREDIT_ALLOWANCE = '15';
process.env.AI_CREDITS_ENFORCE = 'false';
delete process.env.DATABASE_URL;

const app = require('../src/server');
const providerGateway = require('../src/lib/providerGateway');
const memoryStore = require('../src/lib/store/memoryStore');
const aiBrief = require('../src/routes/aiBrief');
const dailyBriefCapability = require('../capabilities/daily_brief.json');

const REMOTE_CONFIG_PATH = path.join(__dirname, '..', 'src', 'config', 'remote-config.json');
const originalRemoteConfig = fs.readFileSync(REMOTE_CONFIG_PATH, 'utf8');

function restoreRemoteConfig() {
  fs.writeFileSync(REMOTE_CONFIG_PATH, originalRemoteConfig);
  aiBrief.loadRemoteFeatures();
}

function request(port, method, reqPath, headers, body) {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(
      { port, path: reqPath, method, headers: Object.assign({ 'content-type': 'application/json' }, headers) },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          let json = null;
          try { json = raw ? JSON.parse(raw) : null; } catch (_e) { /* not JSON, e.g. empty 204 */ }
          resolve({ status: res.statusCode, raw, json });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const baseHeaders = (extra) => Object.assign(
  { 'X-Plyndi-Client-Key': CLIENT_KEY, 'X-Plyndi-Platform': 'ios', 'X-Plyndi-App-Version': '1.0' },
  extra
);
function postDigest(port, body, identityHeaders) {
  return request(port, 'POST', '/v1/ai/brief/digest', baseHeaders(identityHeaders), body);
}
function getBrief(port, localDate, identityHeaders) {
  return request(port, 'GET', `/v1/ai/brief?localDate=${encodeURIComponent(localDate)}`, baseHeaders(identityHeaders));
}
function entitlement(port, identityHeaders) {
  return request(port, 'GET', '/v1/ai/entitlement', baseHeaders(identityHeaders));
}

let providerCallCount = 0;
let providerBehavior = () => JSON.stringify({ brief: 'You have no updates today.' });
async function stubProvider() {
  providerCallCount += 1;
  return providerBehavior();
}
function resetProviderState(nextBehavior) {
  providerCallCount = 0;
  providerGateway.breakers.clear();
  providerGateway.PROVIDERS.openai = stubProvider;
  providerGateway.PROVIDERS.gemini = stubProvider;
  if (nextBehavior) providerBehavior = nextBehavior;
}

function isoDateOffset(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

const sampleDigest = {
  locale: 'en',
  spend: { status: 'over', amount: 2400, currencySymbol: 'NT$', category: 'dining' },
  tasks: { dueTodayCount: 3, overdueCount: 1 },
  trip: { name: 'Osaka', daysUntil: 9 },
  packing: { uncheckedCount: 4 },
};

async function main() {
  const port = await new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server.address().port));
  });
  const today = isoDateOffset(0);

  // ---------------------------------------------------------------------------
  // 1. POST /v1/ai/brief/digest stores without generating — provider call count stays ZERO.
  // ---------------------------------------------------------------------------
  console.log('\n=== POST /v1/ai/brief/digest stores without generating ===');
  memoryStore._resetForTests();
  resetProviderState();
  const device1 = { 'X-Plyndi-Device-ID': 'DEVICE-BRIEF-1' };
  const postRes = await postDigest(port, { localDate: today, timeZone: 'Asia/Taipei', digest: sampleDigest }, device1);
  assertEqual('digest POST -> 200', postRes.status, 200);
  assertEqual('digest POST response echoes localDate', postRes.json && postRes.json.localDate, today);
  assertEqual('provider NOT called by the digest POST', providerCallCount, 0);

  // ---------------------------------------------------------------------------
  // 2. First GET generates once; second GET for the same localDate returns cached, provider call
  //    count stays at 1.
  // ---------------------------------------------------------------------------
  console.log('\n=== first GET generates once; second GET is cached; provider called once total ===');
  const first = await getBrief(port, today, device1);
  assertEqual('first GET -> 200', first.status, 200);
  check('first GET returns a non-empty brief string', typeof first.json.brief === 'string' && first.json.brief.length > 0, JSON.stringify(first.json));
  assertEqual('first GET is NOT cached (freshly generated)', first.json.cached, false);
  assertEqual('provider called exactly once', providerCallCount, 1);

  const second = await getBrief(port, today, device1);
  assertEqual('second GET -> 200', second.status, 200);
  assertEqual('second GET IS cached', second.json.cached, true);
  assertEqual('second GET returns the SAME brief text as the first', second.json.brief, first.json.brief);
  assertEqual('second GET reports the SAME generatedAt as the first (not re-stamped on cache hit)', second.json.generatedAt, first.json.generatedAt);
  check('generatedAt is a valid, recent timestamp (stamped at generation, not at the earlier digest POST)', Math.abs(Date.now() - Date.parse(first.json.generatedAt)) < 10000, first.json.generatedAt);
  assertEqual('provider still called only once total', providerCallCount, 1);

  // ---------------------------------------------------------------------------
  // 3. A different localDate is a new brief — a new provider call.
  // ---------------------------------------------------------------------------
  console.log('\n=== a different localDate generates again (new day = new brief) ===');
  const tomorrow = isoDateOffset(1);
  const postTomorrow = await postDigest(port, { localDate: tomorrow, timeZone: 'Asia/Taipei', digest: sampleDigest }, device1);
  assertEqual('digest POST for a different day -> 200', postTomorrow.status, 200);
  const tomorrowGet = await getBrief(port, tomorrow, device1);
  assertEqual('GET for the new day -> 200', tomorrowGet.status, 200);
  assertEqual('GET for the new day is NOT cached', tomorrowGet.json.cached, false);
  assertEqual('provider called a second time for the new day', providerCallCount, 2);

  // ---------------------------------------------------------------------------
  // 4. No digest posted yet for this (subject, localDate) -> 204, NOT an error, no provider call.
  // ---------------------------------------------------------------------------
  console.log('\n=== no digest posted yet -> 204, not an error, no provider call ===');
  resetProviderState();
  const noDigestDevice = { 'X-Plyndi-Device-ID': 'DEVICE-BRIEF-NODIGEST' };
  const noDigestRes = await getBrief(port, today, noDigestDevice);
  assertEqual('GET with no digest ever posted for this subject -> 204', noDigestRes.status, 204);
  assertEqual('204 body is empty', noDigestRes.raw, '');
  assertEqual('provider NOT called', providerCallCount, 0);

  // ---------------------------------------------------------------------------
  // 5. Re-posting a digest does NOT invalidate an already-generated brief, and does NOT re-bill.
  // ---------------------------------------------------------------------------
  console.log('\n=== re-posting a digest does not invalidate an existing brief or re-bill ===');
  resetProviderState();
  const repostRes = await postDigest(
    port,
    { localDate: today, timeZone: 'Asia/Taipei', digest: { ...sampleDigest, spend: { ...sampleDigest.spend, amount: 9999 } } },
    device1
  );
  assertEqual('digest repost -> 200', repostRes.status, 200);
  assertEqual('digest repost did NOT call the provider', providerCallCount, 0);
  const afterRepost = await getBrief(port, today, device1);
  assertEqual('GET after repost still returns the ORIGINAL cached brief text', afterRepost.json.brief, first.json.brief);
  assertEqual('GET after repost is still cached', afterRepost.json.cached, true);
  assertEqual('GET after repost reports the ORIGINAL generatedAt, not the repost time', afterRepost.json.generatedAt, first.json.generatedAt);
  assertEqual('provider still not called (served from cache, not regenerated)', providerCallCount, 0);

  // ---------------------------------------------------------------------------
  // 6. Free for the user (does NOT decrement the monthly allowance) but DOES count toward the
  //    global daily spend cap.
  // ---------------------------------------------------------------------------
  console.log('\n=== free for the user (monthly allowance unaffected), counts toward the global daily cap ===');
  memoryStore._resetForTests();
  resetProviderState();
  const billingDevice = { 'X-Plyndi-Device-ID': 'DEVICE-BRIEF-BILLING' };
  const beforeEntitlement = await entitlement(port, billingDevice);
  assertEqual('creditsUsed is 0 before any brief', beforeEntitlement.json.creditsUsed, 0);
  await postDigest(port, { localDate: today, timeZone: 'Asia/Taipei', digest: sampleDigest }, billingDevice);
  const billingGet = await getBrief(port, today, billingDevice);
  assertEqual('billing GET -> 200', billingGet.status, 200);
  const afterEntitlement = await entitlement(port, billingDevice);
  assertEqual("the brief did NOT draw down the caller's monthly allowance — creditsUsed still 0", afterEntitlement.json.creditsUsed, 0);
  const globalSpendAfterOneBrief = await memoryStore.globalSpendToday();
  assertEqual(
    'the brief DID count toward the global daily spend cap (by globalSpendCost, not creditCost)',
    globalSpendAfterOneBrief,
    dailyBriefCapability.globalSpendCost
  );
  assertEqual('daily_brief.json creditCost is 0 — free for every user', dailyBriefCapability.creditCost, 0);

  // ---------------------------------------------------------------------------
  // 7. Global daily spend cap reached -> no brief, no provider call. Cap set to exactly one
  //    brief's globalSpendCost (never to 0 — Number(process.env.AI_DAILY_CREDIT_CAP) || 2000, the
  //    same pattern src/routes/aiRun.js's own dailyCreditCap() already uses, treats '0' as falsy
  //    and silently falls back to the 2000 default; this is a pre-existing quirk inherited
  //    verbatim from aiRun.js, not something this test works around by accident).
  // ---------------------------------------------------------------------------
  console.log('\n=== global daily spend cap reached -> no brief, no provider call ===');
  memoryStore._resetForTests();
  resetProviderState();
  process.env.AI_DAILY_CREDIT_CAP = String(dailyBriefCapability.globalSpendCost);
  const capDeviceA = { 'X-Plyndi-Device-ID': 'DEVICE-BRIEF-CAP-A' };
  await postDigest(port, { localDate: today, timeZone: 'Asia/Taipei', digest: sampleDigest }, capDeviceA);
  const capFirstRes = await getBrief(port, today, capDeviceA);
  assertEqual('1st brief today exactly exhausts the cap -> 200', capFirstRes.status, 200);
  assertEqual('provider called once for the 1st brief', providerCallCount, 1);

  const capDeviceB = { 'X-Plyndi-Device-ID': 'DEVICE-BRIEF-CAP-B' };
  await postDigest(port, { localDate: today, timeZone: 'Asia/Taipei', digest: sampleDigest }, capDeviceB);
  const cappedRes = await getBrief(port, today, capDeviceB);
  assertEqual('a 2nd, DIFFERENT subject while the cap is already exhausted -> 429', cappedRes.status, 429);
  assertEqual('429 body names the stable error code', cappedRes.json && cappedRes.json.error, 'daily_capacity_reached');
  assertEqual('provider NOT called for the capped request — the cap is checked before any provider call', providerCallCount, 1);
  process.env.AI_DAILY_CREDIT_CAP = '1000'; // restore

  // ---------------------------------------------------------------------------
  // 8. daily_brief disabled in remote-config.json -> no brief, no provider call.
  // ---------------------------------------------------------------------------
  console.log('\n=== daily_brief disabled in remote-config.json -> no brief ===');
  memoryStore._resetForTests();
  resetProviderState();
  const killSwitchDevice = { 'X-Plyndi-Device-ID': 'DEVICE-BRIEF-KILLSWITCH' };
  await postDigest(port, { localDate: today, timeZone: 'Asia/Taipei', digest: sampleDigest }, killSwitchDevice);
  const disabledConfig = JSON.parse(originalRemoteConfig);
  disabledConfig.features.daily_brief = false;
  fs.writeFileSync(REMOTE_CONFIG_PATH, JSON.stringify(disabledConfig, null, 2));
  aiBrief.loadRemoteFeatures();
  const disabledRes = await getBrief(port, today, killSwitchDevice);
  assertEqual('GET while daily_brief feature flag is false -> 403', disabledRes.status, 403);
  assertEqual('403 body names the stable error code', disabledRes.json && disabledRes.json.error, 'capability_disabled');
  assertEqual('provider NOT called while disabled', providerCallCount, 0);
  restoreRemoteConfig();
  const reenabledRes = await getBrief(port, today, killSwitchDevice);
  assertEqual('GET after the feature flag is restored -> 200 (digest was preserved the whole time)', reenabledRes.status, 200);
  assertEqual('provider called once now that it is re-enabled', providerCallCount, 1);

  // ---------------------------------------------------------------------------
  // 9. Bad / absent / far-future localDate -> rejected, no provider call.
  // ---------------------------------------------------------------------------
  console.log('\n=== bad/absent/far-future localDate is rejected, no provider call ===');
  resetProviderState();
  const validationDevice = { 'X-Plyndi-Device-ID': 'DEVICE-BRIEF-VALIDATION' };

  const missingDate = await request(port, 'GET', '/v1/ai/brief', baseHeaders(validationDevice));
  assertEqual('GET with no localDate query param -> 400', missingDate.status, 400);
  assertEqual('error code is invalid_local_date', missingDate.json && missingDate.json.error, 'invalid_local_date');

  const malformedDate = await getBrief(port, 'not-a-date', validationDevice);
  assertEqual('GET with a malformed localDate -> 400', malformedDate.status, 400);

  const impossibleDate = await getBrief(port, '2026-02-30', validationDevice);
  assertEqual('GET with a syntactically-shaped but impossible calendar date -> 400', impossibleDate.status, 400);

  const farFutureDate = isoDateOffset(30);
  const farFutureRes = await getBrief(port, farFutureDate, validationDevice);
  assertEqual('GET with a localDate 30 days in the future -> 400', farFutureRes.status, 400);

  const withinToleranceDate = isoDateOffset(1);
  const withinToleranceDigest = await postDigest(port, { localDate: withinToleranceDate, timeZone: 'Asia/Taipei', digest: sampleDigest }, validationDevice);
  assertEqual('POST with a localDate 1 day out (within tolerance) -> 200', withinToleranceDigest.status, 200);

  const badPostDate = await postDigest(port, { localDate: 'nope', timeZone: 'Asia/Taipei', digest: sampleDigest }, validationDevice);
  assertEqual('POST digest with a malformed localDate -> 400', badPostDate.status, 400);

  const badTimeZone = await postDigest(port, { localDate: today, timeZone: 'Not/A_Real_Zone', digest: sampleDigest }, validationDevice);
  assertEqual('POST digest with an invalid IANA timeZone -> 400', badTimeZone.status, 400);
  assertEqual('error code is invalid_time_zone', badTimeZone.json && badTimeZone.json.error, 'invalid_time_zone');

  assertEqual('none of the validation-rejection requests above called the provider', providerCallCount, 0);

  // ---------------------------------------------------------------------------
  // Final sanity: the server is still up and serving after everything above.
  // ---------------------------------------------------------------------------
  const health = await request(port, 'GET', '/healthz', {});
  assertEqual('server still boots and serves end to end, throughout, on the memory store alone', health.status, 200);

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  process.exitCode = failures === 0 ? 0 : 1;
  process.exit(process.exitCode); // the in-process server keeps the event loop alive otherwise
}

main().catch((err) => {
  console.error('Test script crashed:', err);
  restoreRemoteConfig();
  process.exitCode = 1;
  process.exit(1);
});
