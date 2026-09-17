// Plain-Node smoke test for /v1/config — this project has no test framework, so this is a
// self-contained script: `node scripts/test-config.js`. Exits non-zero on any failure.
//
// Covers:
//   1. src/lib/semver.js's comparator, including the "1.10.0" vs "1.9.0" lexical trap.
//   2. A real server boot on an ephemeral port, hit with real HTTP requests:
//      - full payload shape (every key RemoteConfig.swift decodes)
//      - version below/above the minimum, and no version header at all
//      - ETag / If-None-Match → 304
//      - SIGHUP config reload with NO process restart
//      - a corrupted config file falling back to the permissive default
//
// The on-disk remote-config.json is temporarily overwritten during the server tests and always
// restored afterwards, even on failure.

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const { compareVersions } = require('../src/lib/semver');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'src', 'config', 'remote-config.json');

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

// ---------------------------------------------------------------------------
// 1. Comparator table
// ---------------------------------------------------------------------------
console.log('\n=== compareVersions ===');
assertEqual('1.10.0 vs 1.9.0 (the lexical trap)', compareVersions('1.10.0', '1.9.0'), 1);
assertEqual('1.9.0 vs 1.10.0', compareVersions('1.9.0', '1.10.0'), -1);
assertEqual('1.9.0 vs 1.9.0 (equal)', compareVersions('1.9.0', '1.9.0'), 0);
assertEqual('2.0.0 vs 1.9.9', compareVersions('2.0.0', '1.9.9'), 1);
assertEqual('null vs 1.0.0', compareVersions(null, '1.0.0'), null);
assertEqual('undefined vs 1.0.0', compareVersions(undefined, '1.0.0'), null);
assertEqual('"" vs 1.0.0', compareVersions('', '1.0.0'), null);
assertEqual('garbage vs 1.0.0', compareVersions('not-a-version', '1.0.0'), null);
assertEqual('1.0.0 vs garbage', compareVersions('1.0.0', 'not-a-version'), null);

// ---------------------------------------------------------------------------
// 2. Live server tests
// ---------------------------------------------------------------------------

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function get(port, reqPath, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ port, path: reqPath, method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = body ? JSON.parse(body) : null; } catch (_e) { /* not JSON, e.g. "ok" or empty 304 */ }
        resolve({ status: res.statusCode, headers: res.headers, body, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealthz(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await get(port, '/healthz');
      if (res.status === 200) return true;
    } catch (_e) {
      // server not up yet
    }
    await delay(100);
  }
  return false;
}

function makeConfig(overrides) {
  return JSON.stringify(Object.assign({
    configVersion: 42,
    minSupportedVersion: '1.9.0',
    recommendedVersion: '2.0.0',
    updateUrl: 'https://example.com/update',
    features: {
      ai_hub: true,
      budget_insights: true,
      daily_plan: true,
      shopping_suggestions: true,
      quick_add_parse: true,
      receipt_scan: true,
      trip_itinerary_day: true,
      workout_plan: true,
      form_coach: true,
      readiness: true
    },
    messages: { banner: null },
    ttlSeconds: 900
  }, overrides), null, 2);
}

const CLIENT_KEY = 'test-shared-key';

async function main() {
  const originalConfig = fs.readFileSync(CONFIG_PATH, 'utf8');
  let child = null;
  let stdout = '';
  let stderr = '';

  try {
    fs.writeFileSync(CONFIG_PATH, makeConfig());

    const port = await freePort();
    child = spawn('node', ['src/server.js'], {
      cwd: ROOT,
      env: Object.assign({}, process.env, { PORT: String(port), CLIENT_SHARED_KEY: CLIENT_KEY }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', (c) => { stdout += c.toString(); });
    child.stderr.on('data', (c) => { stderr += c.toString(); });

    const up = await waitForHealthz(port, 5000);
    check('server boots and /healthz responds', up);
    if (!up) throw new Error('server never came up');

    const authHeaders = (extra) => Object.assign({ 'X-Plyndi-Client-Key': CLIENT_KEY, 'X-Plyndi-Platform': 'ios' }, extra);

    console.log('\n=== GET /v1/config — normal request ===');
    const normal = await get(port, '/v1/config', authHeaders({ 'X-Plyndi-App-Version': '2.0.0' }));
    assertEqual('status 200', normal.status, 200);
    const expectedKeys = [
      'configVersion', 'serverTime', 'minSupportedVersion', 'recommendedVersion',
      'updateRequired', 'updateRecommended', 'updateUrl', 'features', 'messages', 'ttlSeconds'
    ];
    for (const key of expectedKeys) {
      check(`response has key "${key}"`, normal.json && Object.prototype.hasOwnProperty.call(normal.json, key));
    }
    assertEqual('configVersion', normal.json.configVersion, 42);
    assertEqual('updateRequired false at exactly-recommended version', normal.json.updateRequired, false);
    assertEqual('updateRecommended false when caller == recommendedVersion', normal.json.updateRecommended, false);

    console.log('\n=== version gate ===');
    const below = await get(port, '/v1/config', authHeaders({ 'X-Plyndi-App-Version': '0.9.0' }));
    assertEqual('0.9.0 < minSupportedVersion 1.9.0 → updateRequired true', below.json.updateRequired, true);

    const above = await get(port, '/v1/config', authHeaders({ 'X-Plyndi-App-Version': '1.10.0' }));
    assertEqual('1.10.0 vs minSupportedVersion 1.9.0 (lexical trap) → updateRequired false', above.json.updateRequired, false);

    const noHeader = await get(port, '/v1/config', authHeaders());
    assertEqual('no X-Plyndi-App-Version header → updateRequired false (fail open)', noHeader.json.updateRequired, false);

    console.log('\n=== ETag / If-None-Match ===');
    const etag = normal.headers.etag;
    check('ETag header present', Boolean(etag), 'no etag header on normal response');
    assertEqual('Cache-Control is no-cache', normal.headers['cache-control'], 'no-cache');
    const revalidated = await get(port, '/v1/config', authHeaders({ 'X-Plyndi-App-Version': '2.0.0', 'If-None-Match': etag }));
    assertEqual('If-None-Match with matching ETag → 304', revalidated.status, 304);

    console.log('\n=== SIGHUP reload (no restart) ===');
    const pidBeforeReload = child.pid;
    fs.writeFileSync(CONFIG_PATH, makeConfig({ features: Object.assign({}, JSON.parse(makeConfig()).features, { budget_insights: false }) }));
    child.kill('SIGHUP');
    await delay(400);
    const afterReload = await get(port, '/v1/config', authHeaders({ 'X-Plyndi-App-Version': '2.0.0' }));
    assertEqual('same process (no restart)', child.pid, pidBeforeReload);
    assertEqual('budget_insights flipped to false after SIGHUP, no restart', afterReload.json.features.budget_insights, false);
    check('boot/reload logged configVersion', stdout.includes('[config] loaded remote-config.json — configVersion='), stdout);

    console.log('\n=== corrupted config file ===');
    fs.writeFileSync(CONFIG_PATH, '{ this is not valid json');
    child.kill('SIGHUP');
    await delay(400);
    const corrupted = await get(port, '/v1/config', authHeaders({ 'X-Plyndi-App-Version': '2.0.0' }));
    assertEqual('corrupted file → still 200', corrupted.status, 200);
    assertEqual('corrupted file → permissive minSupportedVersion 0.0.0', corrupted.json.minSupportedVersion, '0.0.0');
    assertEqual('corrupted file → updateRequired false', corrupted.json.updateRequired, false);
    assertEqual('corrupted file → features permissive (budget_insights true again)', corrupted.json.features.budget_insights, true);
    check('failure logged loudly', stderr.includes('[config] FAILED to load remote-config.json'), stderr);

    console.log('\n=== side effects on unrelated routes ===');
    const healthzStillOpen = await get(port, '/healthz');
    assertEqual('/healthz still open, no client key needed', healthzStillOpen.status, 200);
  } finally {
    if (child) child.kill();
    fs.writeFileSync(CONFIG_PATH, originalConfig);
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error('Test script crashed:', err);
  try { fs.readFileSync(CONFIG_PATH, 'utf8'); } catch (_e) { /* ignore */ }
  process.exitCode = 1;
});
