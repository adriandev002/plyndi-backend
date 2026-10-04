// Plain-Node smoke test for Phase 3-A + 3-B: identity resolution (src/lib/subject.js), the
// credit ledger + GET /v1/ai/entitlement, shadow-mode enforcement (AI_CREDITS_ENFORCE), the
// global daily spend cap (AI_DAILY_CREDIT_CAP), per-plan allowances via server-verified
// StoreKit 2 entitlements (src/lib/entitlement.js — resolvePlan), and POST
// /v1/ai/entitlement/verify's JWS verification (Apple Root CA chain, ES256 signature,
// bundle/product/expiry/revocation). Same style as scripts/test-ai-run.js: no framework, one
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
  const bareRes = await runCapability(port, 'quick_add_parse', { text: 'spent 300 on lunch', todayISO: '2026-09-19' }, {});
  assertEqual('a request with zero identity headers -> 200 (not rejected)', bareRes.status, 200);
  assertEqual('provider WAS called — the request was actually served, not silently dropped', providerCallCount, 1);

  // ---------------------------------------------------------------------------
  // 2. subject resolution precedence: verified JWT > device id > anon; each is its own bucket;
  //    an invalid token falls through instead of being treated as a rejection.
  // ---------------------------------------------------------------------------
  console.log('\n=== subject resolution: verified JWT > device id > anon, each its own bucket ===');
  memoryStore._resetForTests();

  resetProviderState();
  const jwtRes = await runCapability(port, 'quick_add_parse', { text: 'spent 300 on lunch', todayISO: '2026-09-19' }, {
    authorization: `Bearer ${tokenFor('user-verified-1', AI_JWT_SECRET)}`,
    'X-Plyndi-Device-ID': 'should-be-ignored-because-jwt-wins',
  });
  assertEqual('a request with a valid bearer token (and a device id present too) -> 200', jwtRes.status, 200);
  const jwtEntitlement = await entitlement(port, { authorization: `Bearer ${tokenFor('user-verified-1', AI_JWT_SECRET)}` });
  assertEqual('the verified-JWT subject used exactly 1 credit', jwtEntitlement.json.creditsUsed, 1);

  resetProviderState();
  const deviceRes = await runCapability(port, 'quick_add_parse', { text: 'spent 300 on lunch', todayISO: '2026-09-19' }, { 'X-Plyndi-Device-ID': 'DEVICE-ABC-123' });
  assertEqual('a request with only a device id -> 200', deviceRes.status, 200);
  const deviceEntitlement = await entitlement(port, { 'X-Plyndi-Device-ID': 'DEVICE-ABC-123' });
  assertEqual('the device-id subject has its OWN 1 credit, not folded into the jwt subject above', deviceEntitlement.json.creditsUsed, 1);

  resetProviderState();
  const anonRes = await runCapability(port, 'quick_add_parse', { text: 'spent 300 on lunch', todayISO: '2026-09-19' }, {});
  assertEqual('a request with neither -> 200 (anon/hashed-IP fallback)', anonRes.status, 200);

  resetProviderState();
  const badTokenRes = await runCapability(port, 'quick_add_parse', { text: 'spent 300 on lunch', todayISO: '2026-09-19' }, {
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
  const quickAddParseRun = await runCapability(port, 'quick_add_parse', { text: 'spent 300 on lunch', todayISO: '2026-09-19' }, mixedDevice);
  assertEqual('quick_add_parse (creditCost 1) run succeeds', quickAddParseRun.status, 200);
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
  const first = await runCapability(port, 'quick_add_parse', { text: 'spent 300 on lunch', todayISO: '2026-09-19' }, idemDevice, idemKey);
  const second = await runCapability(port, 'quick_add_parse', { text: 'spent 300 on lunch', todayISO: '2026-09-19' }, idemDevice, idemKey);
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
    const r = await runCapability(port, 'quick_add_parse', { text: 'spent 300 on lunch', todayISO: '2026-09-19' }, overDevice);
    assertEqual(`run ${i + 1}/5 (within the 5-credit allowance) succeeds`, r.status, 200);
  }
  resetProviderState();
  const sixthRun = await runCapability(port, 'quick_add_parse', { text: 'spent 300 on lunch', todayISO: '2026-09-19' }, overDevice);
  assertEqual('6th run (now over the 5-credit allowance) STILL succeeds with AI_CREDITS_ENFORCE=false', sixthRun.status, 200);
  assertEqual('provider WAS called for the over-allowance run — shadow mode never refuses', providerCallCount, 1);
  check('the overage was logged via console.warn ("over its monthly allowance")', sawOverageWarning);
  console.warn = originalConsoleWarn;
  const shadowEntitlement = await entitlement(port, overDevice);
  assertEqual('GET /v1/ai/entitlement reports enforcing:false while the flag is off', shadowEntitlement.json.enforcing, false);
  assertEqual('GET /v1/ai/entitlement reports plan "free" when no verified entitlement exists', shadowEntitlement.json.plan, 'free');

  // ---------------------------------------------------------------------------
  // 6. AI_CREDITS_ENFORCE=true: the SAME over-allowance subject now gets 402 with reset fields.
  // ---------------------------------------------------------------------------
  console.log('\n=== AI_CREDITS_ENFORCE=true: the same over-allowance subject now gets 402 ===');
  process.env.AI_CREDITS_ENFORCE = 'true';
  resetProviderState();
  const seventhRun = await runCapability(port, 'quick_add_parse', { text: 'spent 300 on lunch', todayISO: '2026-09-19' }, overDevice);
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
  const capFirst = await runCapability(port, 'quick_add_parse', { text: 'spent 300 on lunch', todayISO: '2026-09-19' }, { 'X-Plyndi-Device-ID': 'DEVICE-CAP-A' });
  assertEqual('1st credit spent today (cap is 2) -> 200', capFirst.status, 200);
  resetProviderState();
  const capSecond = await runCapability(port, 'quick_add_parse', { text: 'spent 300 on lunch', todayISO: '2026-09-19' }, { 'X-Plyndi-Device-ID': 'DEVICE-CAP-B' });
  assertEqual('2nd credit spent today, a DIFFERENT subject (the cap is global, not per-subject) -> 200', capSecond.status, 200);
  resetProviderState();
  const capThird = await runCapability(port, 'quick_add_parse', { text: 'spent 300 on lunch', todayISO: '2026-09-19' }, { 'X-Plyndi-Device-ID': 'DEVICE-CAP-C' });
  assertEqual('3rd request today (cap already at 2/2), a THIRD distinct subject -> 429', capThird.status, 429);
  assertEqual('429 body names the stable error code', capThird.json && capThird.json.error, 'daily_capacity_reached');
  assertEqual('provider call count is ZERO for the capped request — it never reached the provider', providerCallCount, 0);
  process.env.AI_DAILY_CREDIT_CAP = '1000'; // restore

  // ---------------------------------------------------------------------------
  // 8. Phase 3-B: per-plan allowances. 'premium' requires a server-verified entitlement
  //    (written only via POST /v1/ai/entitlement/verify, or directly in this suite to
  //    simulate one); everything else is 'free'. Both /v1/ai/run enforcement and the
  //    /v1/ai/entitlement meter must agree, because both call resolvePlan().
  // ---------------------------------------------------------------------------
  console.log('\n=== Phase 3-B: free vs premium plans via server-verified entitlement ===');
  memoryStore._resetForTests();
  process.env.AI_CREDITS_ENFORCE = 'true';
  process.env.AI_MONTHLY_CREDIT_ALLOWANCE = '5'; // free tier (legacy var; the fallback)
  process.env.AI_PREMIUM_MONTHLY_ALLOWANCE = '8'; // premium tier (small, for testing)
  delete process.env.AI_FREE_MONTHLY_ALLOWANCE;

  const freeDevice = { 'X-Plyndi-Device-ID': 'DEVICE-FREE-1' };
  const premDevice = { 'X-Plyndi-Device-ID': 'DEVICE-PREM-1' };

  // 8a. a subject with no verified entitlement is 'free'.
  const freeEnt0 = await entitlement(port, freeDevice);
  assertEqual('fresh subject reports plan=free', freeEnt0.json.plan, 'free');
  assertEqual('fresh subject creditsIncluded = free allowance (5)', freeEnt0.json.creditsIncluded, 5);

  // 8b. a stored, verified, unexpired entitlement -> 'premium' with the premium allowance.
  // (Written directly here to simulate what POST /v1/ai/entitlement/verify writes after
  // cryptographic verification — section 9 exercises the real verify path end to end.)
  await memoryStore.saveEntitlement('dev:DEVICE-PREM-1', {
    productId: 'com.axel.Plyndi.Plyndi.premium.monthly',
    originalTransactionId: '2000000123456789',
    expiresAtMs: Date.now() + 30 * 24 * 60 * 60 * 1000,
    bundleId: 'com.axel.Plyndi.Plyndi',
  });
  const premEnt0 = await entitlement(port, premDevice);
  assertEqual('subject with a verified entitlement reports plan=premium', premEnt0.json.plan, 'premium');
  assertEqual('premium creditsIncluded = premium allowance (8)', premEnt0.json.creditsIncluded, 8);
  check('premium meter includes entitlementExpiresAt', typeof premEnt0.json.entitlementExpiresAt === 'string');

  // 8c. enforcement distinguishes: the premium subject may exceed the FREE allowance...
  for (let i = 0; i < 5; i += 1) {
    resetProviderState();
    // eslint-disable-next-line no-await-in-loop
    const r = await runCapability(port, 'quick_add_parse', { text: 'spent 300 on lunch', todayISO: '2026-09-19' }, premDevice);
    assertEqual(`premium run ${i + 1}/5 succeeds`, r.status, 200);
  }
  resetProviderState();
  const premSixth = await runCapability(port, 'quick_add_parse', { text: 'spent 300 on lunch', todayISO: '2026-09-19' }, premDevice);
  assertEqual('premium 6th run — OVER the free allowance (5) but UNDER premium (8) — succeeds', premSixth.status, 200);
  assertEqual('provider WAS called for it', providerCallCount, 1);

  // ...while a free subject at the same usage is refused, with plan:'free' in the body.
  for (let i = 0; i < 5; i += 1) {
    resetProviderState();
    // eslint-disable-next-line no-await-in-loop
    await runCapability(port, 'quick_add_parse', { text: 'spent 300 on lunch', todayISO: '2026-09-19' }, freeDevice);
  }
  resetProviderState();
  const freeSixth = await runCapability(port, 'quick_add_parse', { text: 'spent 300 on lunch', todayISO: '2026-09-19' }, freeDevice);
  assertEqual('free 6th run (over the 5-credit free allowance) -> 402', freeSixth.status, 402);
  assertEqual('402 body carries plan=free', freeSixth.json && freeSixth.json.plan, 'free');
  assertEqual('provider NEVER called for the refused free run', providerCallCount, 0);

  // 8d. ...and the premium subject IS refused past the PREMIUM allowance, with plan:'premium'.
  resetProviderState();
  await runCapability(port, 'quick_add_parse', { text: 'spent 300 on lunch', todayISO: '2026-09-19' }, premDevice); // 7th credit
  resetProviderState();
  await runCapability(port, 'quick_add_parse', { text: 'spent 300 on lunch', todayISO: '2026-09-19' }, premDevice); // 8th credit
  resetProviderState();
  const premNinth = await runCapability(port, 'quick_add_parse', { text: 'spent 300 on lunch', todayISO: '2026-09-19' }, premDevice);
  assertEqual('premium 9th run (over the 8-credit premium allowance) -> 402', premNinth.status, 402);
  assertEqual('402 body carries plan=premium', premNinth.json && premNinth.json.plan, 'premium');
  assertEqual('provider NEVER called for the refused premium run', providerCallCount, 0);

  // 8e. an expired entitlement lapses back to free.
  await memoryStore.saveEntitlement('dev:DEVICE-PREM-1', {
    productId: 'com.axel.Plyndi.Plyndi.premium.monthly',
    originalTransactionId: '2000000123456789',
    expiresAtMs: Date.now() - 1000,
    bundleId: 'com.axel.Plyndi.Plyndi',
  });
  const lapsedEnt = await entitlement(port, premDevice);
  assertEqual('expired entitlement -> plan falls back to free', lapsedEnt.json.plan, 'free');
  assertEqual('lapsed creditsIncluded = free allowance again', lapsedEnt.json.creditsIncluded, 5);

  // 8f. a revoked entitlement is free too (fail closed).
  await memoryStore.saveEntitlement('dev:DEVICE-PREM-1', {
    productId: 'com.axel.Plyndi.Plyndi.premium.monthly',
    originalTransactionId: '2000000123456789',
    expiresAtMs: Date.now() + 30 * 24 * 60 * 60 * 1000,
    revokedAtMs: Date.now(),
    bundleId: 'com.axel.Plyndi.Plyndi',
  });
  const revokedEnt = await entitlement(port, premDevice);
  assertEqual('revoked entitlement -> plan=free', revokedEnt.json.plan, 'free');

  process.env.AI_CREDITS_ENFORCE = 'false'; // restore the shadow-mode default

  // ---------------------------------------------------------------------------
  // 9. POST /v1/ai/entitlement/verify — StoreKit JWS verification end to end. The JWS is
  //    signed by a throwaway EC P-256 CA chain generated here with openssl (the route is
  //    pointed at that test root via ENTITLEMENT_TRUSTED_ROOT_PEM_PATH, which it reads
  //    fresh per request). Every rejection must be a 422 with the stable reason code and
  //    must store nothing — the plan stays 'free'.
  // ---------------------------------------------------------------------------
  console.log('\n=== POST /v1/ai/entitlement/verify: StoreKit JWS verification ===');
  memoryStore._resetForTests();

  const { execFileSync: execFile } = require('child_process');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');

  function verify(portNum, body, identityHeaders) {
    return request(portNum, 'POST', '/v1/ai/entitlement/verify', baseHeaders(identityHeaders), body);
  }
  const vDevice = { 'X-Plyndi-Device-ID': 'DEVICE-VERIFY-1' };

  // 9a. missing / wrong-typed body -> 400 (no crypto needed).
  const missingRes = await verify(port, {}, vDevice);
  assertEqual('POST /verify with no signedTransaction -> 400', missingRes.status, 400);
  assertEqual('400 body names the stable error code', missingRes.json && missingRes.json.error, 'invalid_request');
  const wrongTypeRes = await verify(port, { signedTransaction: 12345 }, vDevice);
  assertEqual('POST /verify with non-string signedTransaction -> 400', wrongTypeRes.status, 400);

  // 9b. garbage JWS -> 422 malformed_jws, nothing stored.
  const garbageRes = await verify(port, { signedTransaction: 'not-a-jws' }, vDevice);
  assertEqual('POST /verify with garbage -> 422', garbageRes.status, 422);
  assertEqual('422 body names the stable error code', garbageRes.json && garbageRes.json.error, 'entitlement_unverified');
  assertEqual('422 body carries the reason code', garbageRes.json && garbageRes.json.reason, 'malformed_jws');
  const afterGarbage = await entitlement(port, vDevice);
  assertEqual('a rejected JWS stores nothing — plan stays free', afterGarbage.json.plan, 'free');

  let haveOpenssl = true;
  try {
    execFile('openssl', ['version'], { stdio: 'ignore' });
  } catch (_e) { haveOpenssl = false; }

  if (!haveOpenssl) {
    console.log('  SKIP  openssl not on PATH — skipping JWS crypto scenarios (9c-9i)');
  } else {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plyndi-enttest-'));
    const sh = (args) => execFile('openssl', args, { cwd: tmpDir, stdio: 'ignore' });
    // Throwaway chain: test root -> test intermediate -> test leaf (mirrors Apple's
    // root -> WWDR intermediate -> leaf shape).
    sh(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256',
      '-keyout', 'root-key.pem', '-out', 'root-cert.pem', '-days', '3650', '-nodes',
      '-subj', '/CN=Plyndi Test Root CA']);
    fs.writeFileSync(path.join(tmpDir, 'ext-inter.cnf'),
      'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n');
    sh(['req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256',
      '-keyout', 'inter-key.pem', '-out', 'inter.csr', '-nodes',
      '-subj', '/CN=Plyndi Test Intermediate']);
    sh(['x509', '-req', '-in', 'inter.csr', '-CA', 'root-cert.pem', '-CAkey', 'root-key.pem',
      '-CAcreateserial', '-out', 'inter-cert.pem', '-days', '1825', '-extfile', 'ext-inter.cnf']);
    fs.writeFileSync(path.join(tmpDir, 'ext-leaf.cnf'),
      'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n');
    sh(['req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256',
      '-keyout', 'leaf-key.pem', '-out', 'leaf.csr', '-nodes',
      '-subj', '/CN=Plyndi Test Leaf']);
    sh(['x509', '-req', '-in', 'leaf.csr', '-CA', 'inter-cert.pem', '-CAkey', 'inter-key.pem',
      '-CAcreateserial', '-out', 'leaf-cert.pem', '-days', '825', '-extfile', 'ext-leaf.cnf']);

    const b64der = (name) => fs.readFileSync(path.join(tmpDir, name)).toString('base64');
    const b64u = (buf) => Buffer.from(buf).toString('base64url');
    const chain = [b64der('leaf-cert.pem'), b64der('inter-cert.pem'), b64der('root-cert.pem')];
    const leafKeyPem = fs.readFileSync(path.join(tmpDir, 'leaf-key.pem'), 'utf8');

    // Point the verifier at the TEST root (read fresh per request, so mid-run is fine).
    process.env.ENTITLEMENT_TRUSTED_ROOT_PEM_PATH = path.join(tmpDir, 'root-cert.pem');

    function signJws(payload, keyPem, x5c) {
      const h = b64u(JSON.stringify({ alg: 'ES256', x5c }));
      const p = b64u(JSON.stringify(payload));
      const sig = crypto.sign('sha256', Buffer.from(`${h}.${p}`, 'utf8'),
        { key: keyPem, dsaEncoding: 'ieee-p1363' });
      return `${h}.${p}.${b64u(sig)}`;
    }
    const txPayload = (overrides) => Object.assign({
      bundleId: 'com.axel.Plyndi.Plyndi',
      productId: 'com.axel.Plyndi.Plyndi.premium.monthly',
      transactionId: '2000000123456789',
      originalTransactionId: '2000000123456789',
      expiresDate: Date.now() + 30 * 24 * 60 * 60 * 1000,
      environment: 'Xcode',
    }, overrides);

    // 9c. happy path -> 200, and the meter flips to premium with the premium allowance.
    const goodJws = signJws(txPayload(), leafKeyPem, chain);
    const goodRes = await verify(port, { signedTransaction: goodJws }, vDevice);
    assertEqual('POST /verify with a valid test-chain JWS -> 200', goodRes.status, 200);
    assertEqual('200 body reports plan=premium', goodRes.json && goodRes.json.plan, 'premium');
    check('200 body includes expiresAt', goodRes.json && typeof goodRes.json.expiresAt === 'string');
    const afterGood = await entitlement(port, vDevice);
    assertEqual('after verify, GET /entitlement reports plan=premium', afterGood.json.plan, 'premium');
    assertEqual('the meter uses the premium allowance (8)', afterGood.json.creditsIncluded, 8);
    // And enforcement agrees with the meter — the same resolvePlan() serves both.
    resetProviderState();
    for (let i = 0; i < 6; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await runCapability(port, 'quick_add_parse', { text: 'spent 300 on lunch', todayISO: '2026-09-19' }, vDevice);
    }
    resetProviderState();
    const overFree = await runCapability(port, 'quick_add_parse', { text: 'spent 300 on lunch', todayISO: '2026-09-19' }, vDevice);
    assertEqual('verified-premium subject runs past the free allowance (5) -> 200', overFree.status, 200);

    // 9d-9h. every failure mode -> 422 with its reason, storing nothing.
    async function expectReject(label, jws, reason) {
      const dev = { 'X-Plyndi-Device-ID': `DEVICE-VERIFY-${reason.toUpperCase()}` };
      // eslint-disable-next-line no-await-in-loop
      const r = await verify(port, { signedTransaction: jws }, dev);
      assertEqual(`${label} -> 422`, r.status, 422);
      assertEqual(`${label} reason code`, r.json && r.json.reason, reason);
      // eslint-disable-next-line no-await-in-loop
      const ent = await entitlement(port, dev);
      assertEqual(`${label}: nothing stored, plan stays free`, ent.json.plan, 'free');
    }
    await expectReject('wrong bundleId', signJws(txPayload({ bundleId: 'com.evil.app' }), leafKeyPem, chain), 'wrong_bundle');
    await expectReject('unknown productId', signJws(txPayload({ productId: 'com.evil.premium' }), leafKeyPem, chain), 'unknown_product');
    await expectReject('expired transaction', signJws(txPayload({ expiresDate: Date.now() - 1000 }), leafKeyPem, chain), 'expired');
    await expectReject('revoked transaction', signJws(txPayload({ revocationDate: Date.now() }), leafKeyPem, chain), 'revoked');

    // Tampered signature: flip the tail of the signature segment (still valid base64url).
    const tParts = goodJws.split('.');
    tParts[2] = tParts[2].slice(0, -2) + (tParts[2].slice(-2) === 'AA' ? 'BB' : 'AA');
    await expectReject('tampered signature', tParts.join('.'), 'bad_signature');

    // 9i. a chain anchored at a DIFFERENT root the verifier doesn't trust.
    sh(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256',
      '-keyout', 'evil-key.pem', '-out', 'evil-cert.pem', '-days', '3650', '-nodes',
      '-subj', '/CN=Evil Root']);
    const evilKeyPem = fs.readFileSync(path.join(tmpDir, 'evil-key.pem'), 'utf8');
    await expectReject('untrusted root', signJws(txPayload(), evilKeyPem, [b64der('evil-cert.pem')]), 'untrusted_chain');

    delete process.env.ENTITLEMENT_TRUSTED_ROOT_PEM_PATH;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

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
