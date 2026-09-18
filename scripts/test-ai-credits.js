// Plain-Node smoke test for Phase 3-A: identity resolution (src/lib/subject.js), the credit
// ledger + GET /v1/ai/entitlement, shadow-mode enforcement (AI_CREDITS_ENFORCE), and the global
// daily spend cap (AI_DAILY_CREDIT_CAP). Same style as scripts/test-ai-run.js: no framework, one
// in-process HTTP server, the provider layer stubbed (this environment can't reach OpenAI/Gemini,
// and a suite that spends real money per run would be a bad suite regardless), and this repo's
// only Postgres-capable environment variable (DATABASE_URL) deliberately left unset throughout —
// this suite ONLY ever runs against src/lib/store/memoryStore.js, using its _resetForTests()
// escape hatch to start each scenario from a clean ledger.
//
// Run: node scripts/test-ai-credits.js

const http = require('http');
const crypto = require('crypto');

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
const AI_JWT_SECRET = 'test-ai-jwt-secret';
process.env.CLIENT_SHARED_KEY = CLIENT_KEY;
process.env.AI_JWT_SECRET = AI_JWT_SECRET;
// Explicit values for this suite so it never depends on whatever a real .env happens to set.
// AI_CREDITS_ENFORCE and AI_DAILY_CREDIT_CAP are re-set mid-run below (they're read fresh from
// process.env on every request — see src/routes/aiRun.js's creditsEnforceFlag()/dailyCreditCap()
// — precisely so this single already-listening server can exercise both settings of each flag).
process.env.AI_CREDITS_ENFORCE = 'false';
process.env.AI_MONTHLY_CREDIT_ALLOWANCE = '5';
process.env.AI_DAILY_CREDIT_CAP = '1000';
delete process.env.DATABASE_URL;

// ---------------------------------------------------------------------------
// 0. DATABASE_URL unset -> the server must still boot (on the memory store) and log a loud,
//    unmistakable warning that runs/credits are not durable. Captured around the require() below,
//    since src/lib/store/index.js decides and logs this exactly once, at first require.
// ---------------------------------------------------------------------------
console.log('\n=== DATABASE_URL unset: server still boots, on the memory store, with a loud warning ===');
let sawNonDurableWarning = false;
const originalConsoleWarn = console.warn;
console.warn = (...args) => {
  const line = args.join(' ');
  if (line.includes('DATABASE_URL is NOT set') && line.includes('NOT durable')) sawNonDurableWarning = true;
  originalConsoleWarn(...args);
};
const app = require('../src/server');
const providerGateway = require('../src/lib/providerGateway');
const memoryStore = require('../src/lib/store/memoryStore');
console.warn = originalConsoleWarn;
check('DATABASE_URL was unset and the server logged the non-durable in-memory-store warning at boot', sawNonDurableWarning);

// ---------------------------------------------------------------------------
// Server + stub plumbing (same pattern as scripts/test-ai-run.js).
// ---------------------------------------------------------------------------
function tokenFor(subject, secret, expiresInSeconds = 300) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode({ sub: subject, exp: Math.floor(Date.now() / 1000) + expiresInSeconds });
  const signature = crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

let providerCallCount = 0;
let providerBehavior = () => JSON.stringify({ score: 80, intensity: 'moderate', recovery: { tips: ['rest'] }, summary: 'ok' });
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
          try { json = raw ? JSON.parse(raw) : null; } catch (_e) { /* not JSON */ }
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
function runCapability(port, capabilityId, context, identityHeaders, idempotencyKey) {
  return request(port, 'POST', '/v1/ai/run', baseHeaders(identityHeaders), { capabilityId, context, idempotencyKey });
}
function entitlement(port, identityHeaders) {
  return request(port, 'GET', '/v1/ai/entitlement', baseHeaders(identityHeaders));
}

async function main() {
  const port = await new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server.address().port));
  });

  // ---------------------------------------------------------------------------
  // 1. NO identity headers at all still succeeds — the shipped-build regression. Every build
  //    installed before Phase 3-B sends neither Authorization nor X-Plyndi-Device-ID.
  // ---------------------------------------------------------------------------
  console.log('\n=== no identity headers at all still succeeds (shipped-build regression) ===');
  memoryStore._resetForTests();
  resetProviderState();
  const bareRes = await runCapability(port, 'readiness', {}, {});
  assertEqual('a request with zero identity headers -> 200 (not rejected)', bareRes.status, 200);
  assertEqual('provider WAS called — the request was actually served, not silently dropped', providerCallCount, 1);

  // ---------------------------------------------------------------------------
  // 2. subject resolution precedence: verified JWT > device id > anon; each is its own bucket;
  //    an invalid token falls through instead of being treated as a rejection.
  // ---------------------------------------------------------------------------
  console.log('\n=== subject resolution: verified JWT > device id > anon, each its own bucket ===');
  memoryStore._resetForTests();

  resetProviderState();
  const jwtRes = await runCapability(port, 'readiness', {}, {
    authorization: `Bearer ${tokenFor('user-verified-1', AI_JWT_SECRET)}`,
    'X-Plyndi-Device-ID': 'should-be-ignored-because-jwt-wins',
  });
  assertEqual('a request with a valid bearer token (and a device id present too) -> 200', jwtRes.status, 200);
  const jwtEntitlement = await entitlement(port, { authorization: `Bearer ${tokenFor('user-verified-1', AI_JWT_SECRET)}` });
  assertEqual('the verified-JWT subject used exactly 1 credit', jwtEntitlement.json.creditsUsed, 1);

  resetProviderState();
  const deviceRes = await runCapability(port, 'readiness', {}, { 'X-Plyndi-Device-ID': 'DEVICE-ABC-123' });
  assertEqual('a request with only a device id -> 200', deviceRes.status, 200);
  const deviceEntitlement = await entitlement(port, { 'X-Plyndi-Device-ID': 'DEVICE-ABC-123' });
  assertEqual('the device-id subject has its OWN 1 credit, not folded into the jwt subject above', deviceEntitlement.json.creditsUsed, 1);

  resetProviderState();
  const anonRes = await runCapability(port, 'readiness', {}, {});
  assertEqual('a request with neither -> 200 (anon/hashed-IP fallback)', anonRes.status, 200);

  resetProviderState();
  const badTokenRes = await runCapability(port, 'readiness', {}, {
    authorization: 'Bearer not-a-real-jwt-at-all',
    'X-Plyndi-Device-ID': 'DEVICE-FALLBACK-1',
  });
  assertEqual('an invalid/unverifiable bearer token falls through to the device id (not a rejection) -> 200', badTokenRes.status, 200);
  const fallbackEntitlement = await entitlement(port, { 'X-Plyndi-Device-ID': 'DEVICE-FALLBACK-1' });
  assertEqual('the fallback landed on the device-id subject, which now has its own 1 credit', fallbackEntitlement.json.creditsUsed, 1);

  // ---------------------------------------------------------------------------
  // 3. ledger records the right creditCost per capability, across a mixed run.
  // ---------------------------------------------------------------------------
  console.log('\n=== ledger totals match creditCost across a mixed run of capabilities ===');
  memoryStore._resetForTests();
  const mixedDevice = { 'X-Plyndi-Device-ID': 'DEVICE-MIXED-1' };
  resetProviderState();
  const readinessRun = await runCapability(port, 'readiness', {}, mixedDevice);
  assertEqual('readiness (creditCost 1) run succeeds', readinessRun.status, 200);
  resetProviderState(() => JSON.stringify({ days: [{ day: 1, exercises: [] }] }));
  const workoutRun = await runCapability(port, 'workout_plan', { goal: 'strength', availableMinutes: 30 }, mixedDevice);
  assertEqual('workout_plan (creditCost 3) run succeeds', workoutRun.status, 200);
  const mixedEntitlement = await entitlement(port, mixedDevice);
  assertEqual('ledger total is 1 + 3 = 4, matching each capability\'s own creditCost exactly', mixedEntitlement.json.creditsUsed, 4);

  // ---------------------------------------------------------------------------
  // 4. idempotent replay charges once, not twice.
  // ---------------------------------------------------------------------------
  console.log('\n=== idempotent replay charges once, not twice ===');
  memoryStore._resetForTests();
  const idemDevice = { 'X-Plyndi-Device-ID': 'DEVICE-IDEM-1' };
  const idemKey = 'idem-credits-test-1';
  resetProviderState();
  const first = await runCapability(port, 'readiness', {}, idemDevice, idemKey);
  const second = await runCapability(port, 'readiness', {}, idemDevice, idemKey);
  assertEqual('first call succeeds', first.status, 200);
  assertEqual('replay (same idempotencyKey) succeeds', second.status, 200);
  assertEqual('same runId returned both times', second.json.runId, first.json.runId);
  assertEqual('provider called exactly once across both requests', providerCallCount, 1);
  const idemEntitlement = await entitlement(port, idemDevice);
  assertEqual('the replay did NOT double-charge — exactly 1 credit used, not 2', idemEntitlement.json.creditsUsed, 1);

  // ---------------------------------------------------------------------------
  // 5. AI_CREDITS_ENFORCE=false (the default): an over-allowance subject still succeeds; the
  //    overage is logged, never refused. AI_MONTHLY_CREDIT_ALLOWANCE=5 from the top of this file.
  // ---------------------------------------------------------------------------
  console.log('\n=== AI_CREDITS_ENFORCE=false: over-allowance subject still succeeds (shadow mode) ===');
  memoryStore._resetForTests();
  process.env.AI_CREDITS_ENFORCE = 'false';
  const overDevice = { 'X-Plyndi-Device-ID': 'DEVICE-OVER-ALLOWANCE-1' };
  let sawOverageWarning = false;
  console.warn = (...args) => {
    if (args.join(' ').includes('over its monthly allowance')) sawOverageWarning = true;
    originalConsoleWarn(...args);
  };
  for (let i = 0; i < 5; i += 1) {
    resetProviderState();
    // eslint-disable-next-line no-await-in-loop
    const r = await runCapability(port, 'readiness', {}, overDevice);
    assertEqual(`run ${i + 1}/5 (within the 5-credit allowance) succeeds`, r.status, 200);
  }
  resetProviderState();
  const sixthRun = await runCapability(port, 'readiness', {}, overDevice);
  assertEqual('6th run (now over the 5-credit allowance) STILL succeeds with AI_CREDITS_ENFORCE=false', sixthRun.status, 200);
  assertEqual('provider WAS called for the over-allowance run — shadow mode never refuses', providerCallCount, 1);
  check('the overage was logged via console.warn ("over its monthly allowance")', sawOverageWarning);
  console.warn = originalConsoleWarn;
  const shadowEntitlement = await entitlement(port, overDevice);
  assertEqual('GET /v1/ai/entitlement reports enforcing:false while the flag is off', shadowEntitlement.json.enforcing, false);
  assertEqual('GET /v1/ai/entitlement never claims a known plan — always "unknown"', shadowEntitlement.json.plan, 'unknown');

  // ---------------------------------------------------------------------------
  // 6. AI_CREDITS_ENFORCE=true: the SAME over-allowance subject now gets 402 with reset fields.
  // ---------------------------------------------------------------------------
  console.log('\n=== AI_CREDITS_ENFORCE=true: the same over-allowance subject now gets 402 ===');
  process.env.AI_CREDITS_ENFORCE = 'true';
  resetProviderState();
  const seventhRun = await runCapability(port, 'readiness', {}, overDevice);
  assertEqual('7th run for the same over-allowance subject -> 402 once enforcement is on', seventhRun.status, 402);
  assertEqual('402 body names the stable error code', seventhRun.json && seventhRun.json.error, 'credits_exhausted');
  check('402 body includes a numeric creditsRemaining', seventhRun.json && typeof seventhRun.json.creditsRemaining === 'number', JSON.stringify(seventhRun.json));
  check('402 body includes periodEnd (the reset field)', seventhRun.json && typeof seventhRun.json.periodEnd === 'string', JSON.stringify(seventhRun.json));
  assertEqual('provider NEVER called once enforcement refuses the request', providerCallCount, 0);
  const enforcingEntitlement = await entitlement(port, overDevice);
  assertEqual('GET /v1/ai/entitlement now reports enforcing:true', enforcingEntitlement.json.enforcing, true);
  process.env.AI_CREDITS_ENFORCE = 'false'; // restore the shadow-mode default for the scenarios below

  // ---------------------------------------------------------------------------
  // 7. Global daily spend cap: over the cap -> 429 for EVERY subject, provider never called.
  // ---------------------------------------------------------------------------
  console.log('\n=== global daily spend cap trips regardless of which subject asks ===');
  memoryStore._resetForTests();
  process.env.AI_DAILY_CREDIT_CAP = '2'; // small cap: 2 one-credit runs exhaust it
  resetProviderState();
  const capFirst = await runCapability(port, 'readiness', {}, { 'X-Plyndi-Device-ID': 'DEVICE-CAP-A' });
  assertEqual('1st credit spent today (cap is 2) -> 200', capFirst.status, 200);
  resetProviderState();
  const capSecond = await runCapability(port, 'readiness', {}, { 'X-Plyndi-Device-ID': 'DEVICE-CAP-B' });
  assertEqual('2nd credit spent today, a DIFFERENT subject (the cap is global, not per-subject) -> 200', capSecond.status, 200);
  resetProviderState();
  const capThird = await runCapability(port, 'readiness', {}, { 'X-Plyndi-Device-ID': 'DEVICE-CAP-C' });
  assertEqual('3rd request today (cap already at 2/2), a THIRD distinct subject -> 429', capThird.status, 429);
  assertEqual('429 body names the stable error code', capThird.json && capThird.json.error, 'daily_capacity_reached');
  assertEqual('provider call count is ZERO for the capped request — it never reached the provider', providerCallCount, 0);
  process.env.AI_DAILY_CREDIT_CAP = '1000'; // restore

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
  process.exitCode = 1;
  process.exit(1);
});
