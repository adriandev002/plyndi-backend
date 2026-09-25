// Plain-Node check that the content GETs and the paid AI routes no longer share one per-IP budget.
// Same style as scripts/test-content.js — no framework, one in-process HTTP server, DATABASE_URL
// unset so only the in-memory store is used. Deliberately its own process: every other test
// script raises RATE_LIMIT_MAX (or never gets near it), and this one needs the real defaults.
//
//   - GET /v1/content/explore and /v1/content/home-banners do NOT spend the general limiter's
//     60-an-hour budget (src/server.js mounts them ahead of it).
//   - An AI route is still limited at exactly its old threshold, 60.
//   - The content routes have their own limiter, CONTENT_RATE_LIMIT_MAX (default 600 per 15 min),
//     and a 304 counts against it like any other request.
//
// Run: node scripts/test-rate-limits.js

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

const CLIENT_KEY = 'test-shared-key';
process.env.CLIENT_SHARED_KEY = CLIENT_KEY;
delete process.env.DATABASE_URL;
// The defaults are what is under test.
for (const key of ['RATE_LIMIT_MAX', 'RATE_LIMIT_WINDOW_MINUTES', 'CONTENT_RATE_LIMIT_MAX']) {
  delete process.env[key];
}
const AI_LIMIT = 60;
const CONTENT_LIMIT = 600;

const app = require('../src/server');

function get(port, reqPath, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ port, path: reqPath, method: 'GET', headers }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

const clientHeaders = (extra) => Object.assign({ 'X-Plyndi-Client-Key': CLIENT_KEY, 'X-Plyndi-Platform': 'ios' }, extra);

async function main() {
  const port = await new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server.address().port));
  });

  // Content requests made so far, all from this one IP — the content limiter's running count.
  let contentRequests = 0;
  const content = async (reqPath, extra) => {
    contentRequests += 1;
    return get(port, reqPath, clientHeaders(extra));
  };

  console.log('\n=== content GETs do not spend the AI routes\' budget ===');
  // Well past the AI limit before a single AI request is made.
  let contentLimited = 0;
  for (let i = 0; i < AI_LIMIT * 2; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const res = await content(i % 2 === 0 ? '/v1/content/explore' : '/v1/content/home-banners?locale=en');
    if (res.status === 429) contentLimited += 1;
  }
  assertEqual(`${AI_LIMIT * 2} content GETs from one IP -> none limited`, contentLimited, 0);

  console.log(`\n=== an AI route is still limited at ${AI_LIMIT} ===`);
  let aiLimited = 0;
  for (let i = 0; i < AI_LIMIT; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const res = await get(port, '/v1/ai/hub', clientHeaders({ 'X-Plyndi-App-Version': '1.0' }));
    if (res.status === 429) aiLimited += 1;
  }
  assertEqual(`the first ${AI_LIMIT} AI requests pass (the content GETs above used none of them)`, aiLimited, 0);
  const overAiLimit = await get(port, '/v1/ai/hub', clientHeaders({ 'X-Plyndi-App-Version': '1.0' }));
  assertEqual(`AI request ${AI_LIMIT + 1} -> 429`, overAiLimit.status, 429);

  console.log('\n=== content GETs still work once the AI budget is spent ===');
  const banners = await content('/v1/content/home-banners?locale=en');
  assertEqual('home-banners after the AI limit -> 200', banners.status, 200);
  const explore = await content('/v1/content/explore');
  assertEqual('explore after the AI limit -> 200', explore.status, 200);

  console.log(`\n=== content GETs have their own limit, ${CONTENT_LIMIT}, and a 304 counts ===`);
  const etag = banners.headers.etag;
  check('home-banners sent an ETag to revalidate with', Boolean(etag));
  let notModified = 0;
  let limitedBeforeCap = 0;
  while (contentRequests < CONTENT_LIMIT) {
    // eslint-disable-next-line no-await-in-loop
    const res = await content('/v1/content/home-banners?locale=en', { 'If-None-Match': etag });
    if (res.status === 304) notModified += 1;
    if (res.status === 429) limitedBeforeCap += 1;
  }
  check('the revalidations were answered 304', notModified > 0, String(notModified));
  assertEqual(`no content GET limited before request ${CONTENT_LIMIT}`, limitedBeforeCap, 0);
  const overContentLimit = await content('/v1/content/home-banners?locale=en', { 'If-None-Match': etag });
  assertEqual(`content GET ${CONTENT_LIMIT + 1} (a would-be 304) -> 429`, overContentLimit.status, 429);
  assertEqual('explore shares that content limit -> 429', (await content('/v1/content/explore')).status, 429);

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  process.exitCode = failures === 0 ? 0 : 1;
  process.exit(process.exitCode);
}

main().catch((err) => {
  console.error('Test script crashed:', err);
  process.exitCode = 1;
  process.exit(1);
});
