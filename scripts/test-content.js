// Plain-Node smoke test for Phase 2's Explore feed content layer: GET /v1/content/explore,
// GET /r/:cardId, and /v1/admin/explore-cards + /v1/admin/explore-clicks. Same style as
// scripts/test-config.js/test-ai-credits.js — no framework, one in-process HTTP server
// (`require('../src/server')` then `app.listen(0)`, see src/server.js's header comment on why
// that works), DATABASE_URL deliberately left unset so this only ever exercises
// src/lib/store/memoryStore.js's explore methods.
//
// Run: node scripts/test-content.js

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
// Unset at require time on purpose — the first test below needs ADMIN_TOKEN to be genuinely
// unset. requireAdminToken (src/routes/admin.js) reads process.env.ADMIN_TOKEN fresh on every
// request, not once at boot, so this script can flip it mid-run without restarting the server —
// same convention scripts/test-ai-credits.js already relies on for AI_CREDITS_ENFORCE.
delete process.env.ADMIN_TOKEN;

const app = require('../src/server');

function request(port, method, reqPath, headers, body) {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        port,
        path: reqPath,
        method,
        headers: Object.assign(payload ? { 'content-type': 'application/json' } : {}, headers),
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          let json = null;
          try { json = raw ? JSON.parse(raw) : null; } catch (_e) { /* not JSON */ }
          resolve({ status: res.statusCode, headers: res.headers, raw, json });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const clientHeaders = (extra) => Object.assign({ 'X-Plyndi-Client-Key': CLIENT_KEY, 'X-Plyndi-Platform': 'ios' }, extra);
const adminHeaders = (extra) => Object.assign({ 'X-Admin-Token': process.env.ADMIN_TOKEN || '' }, extra);

function explore(port, query, headers) {
  return request(port, 'GET', `/v1/content/explore${query || ''}`, clientHeaders(headers));
}
function createCard(port, card) {
  return request(port, 'POST', '/v1/admin/explore-cards', adminHeaders(), card);
}
function deleteCard(port, id) {
  return request(port, 'DELETE', `/v1/admin/explore-cards/${id}`, adminHeaders());
}

async function main() {
  const port = await new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server.address().port));
  });

  // ---------------------------------------------------------------------------
  // 0. ADMIN_TOKEN unset -> every /v1/admin/* route returns 503, never an open admin API.
  // ---------------------------------------------------------------------------
  console.log('\n=== ADMIN_TOKEN unset -> 503 ===');
  const noToken = await request(port, 'GET', '/v1/admin/explore-cards', adminHeaders());
  assertEqual('GET /v1/admin/explore-cards with no ADMIN_TOKEN configured -> 503', noToken.status, 503);
  const noTokenWrite = await createCard(port, { id: 'should-not-be-created' });
  assertEqual('POST /v1/admin/explore-cards with no ADMIN_TOKEN configured -> 503', noTokenWrite.status, 503);

  // From here on, ADMIN_TOKEN is configured — every admin call below sends it.
  process.env.ADMIN_TOKEN = 'test-admin-token';

  console.log('\n=== admin API works once ADMIN_TOKEN is set ===');
  const wrongToken = await request(port, 'GET', '/v1/admin/explore-cards', adminHeaders({ 'X-Admin-Token': 'nope' }));
  assertEqual('wrong admin token -> 401', wrongToken.status, 401);
  const listOk = await request(port, 'GET', '/v1/admin/explore-cards', adminHeaders());
  assertEqual('correct admin token -> 200', listOk.status, 200);
  check('seeded cards are present', Array.isArray(listOk.json.cards) && listOk.json.cards.length >= 3, JSON.stringify(listOk.json));

  const testCardIds = [];
  try {
    // ---------------------------------------------------------------------------
    // 1. Locale fallback to "en" — a card with ONLY "en" text must still resolve when a locale
    //    with no row for it is requested.
    // ---------------------------------------------------------------------------
    console.log('\n=== locale fallback to "en" ===');
    const localeCardId = 'test-locale-fallback-card';
    testCardIds.push(localeCardId);
    const localeCreate = await createCard(port, {
      id: localeCardId,
      type: 'editorial',
      targetUrl: 'https://plyndi.com/test-fixture',
      category: 'lifestyle',
      icon: 'sparkles',
      minAppVersion: '0.0.0',
      weight: 1000, // sort first, easy to find
      published: true,
      text: { en: { tag: 'Tag EN', title: 'Title EN', description: 'Description EN', ctaLabel: 'CTA EN' } },
    });
    assertEqual('create locale-fallback test card -> 201', localeCreate.status, 201);

    const zhHant = await explore(port, '?locale=zh-Hant', { 'X-Plyndi-App-Version': '1.0' });
    const zhHantCard = zhHant.json && zhHant.json.cards.find((c) => c.id === localeCardId);
    check('unrequested locale falls back to "en" text', Boolean(zhHantCard) && zhHantCard.title === 'Title EN', JSON.stringify(zhHantCard));

    // ---------------------------------------------------------------------------
    // 2. min_app_version filtering, and a null/missing app version fails OPEN (includes it).
    // ---------------------------------------------------------------------------
    console.log('\n=== min_app_version filtering ===');
    const versionCardId = 'test-version-gated-card';
    testCardIds.push(versionCardId);
    const versionCreate = await createCard(port, {
      id: versionCardId,
      type: 'editorial',
      targetUrl: 'https://plyndi.com/test-fixture',
      category: 'lifestyle',
      icon: 'sparkles',
      minAppVersion: '5.0.0',
      weight: 999,
      published: true,
      text: { en: { tag: 'Gated', title: 'Gated Card', description: 'Requires 5.0.0+', ctaLabel: 'Go' } },
    });
    assertEqual('create version-gated test card -> 201', versionCreate.status, 201);

    const belowMin = await explore(port, '', { 'X-Plyndi-App-Version': '1.0.0' });
    check(
      'app version 1.0.0 < minAppVersion 5.0.0 -> card excluded',
      !belowMin.json.cards.some((c) => c.id === versionCardId),
      JSON.stringify(belowMin.json.cards.map((c) => c.id))
    );

    const aboveMin = await explore(port, '', { 'X-Plyndi-App-Version': '10.0.0' });
    check(
      'app version 10.0.0 >= minAppVersion 5.0.0 -> card included',
      aboveMin.json.cards.some((c) => c.id === versionCardId),
      JSON.stringify(aboveMin.json.cards.map((c) => c.id))
    );

    const noVersionHeader = await request(port, 'GET', '/v1/content/explore', clientHeaders());
    check(
      'no X-Plyndi-App-Version header at all -> fails open, card included',
      noVersionHeader.json.cards.some((c) => c.id === versionCardId),
      JSON.stringify(noVersionHeader.json.cards.map((c) => c.id))
    );

    // ---------------------------------------------------------------------------
    // 3. ETag / If-None-Match: the same request twice gives an identical ETag, and the second
    //    request (sending it back as If-None-Match) gets a 304.
    // ---------------------------------------------------------------------------
    console.log('\n=== ETag / If-None-Match ===');
    const first = await explore(port, '?locale=en&region=TW', { 'X-Plyndi-App-Version': '10.0.0' });
    const second = await explore(port, '?locale=en&region=TW', { 'X-Plyndi-App-Version': '10.0.0' });
    check('ETag present', Boolean(first.headers.etag), 'no etag header');
    assertEqual('identical request -> identical ETag', first.headers.etag, second.headers.etag);
    assertEqual('Cache-Control carries the real ttlSeconds', first.headers['cache-control'], `max-age=${first.json.ttlSeconds}`);
    const revalidated = await explore(port, '?locale=en&region=TW', {
      'X-Plyndi-App-Version': '10.0.0',
      'If-None-Match': first.headers.etag,
    });
    assertEqual('If-None-Match with matching ETag -> 304', revalidated.status, 304);

    // ---------------------------------------------------------------------------
    // 4. affiliate actionURL points at /r/<id> on THIS server, never the partner domain.
    // ---------------------------------------------------------------------------
    console.log('\n=== affiliate actionURL ===');
    const feed = await explore(port, '', { 'X-Plyndi-App-Version': '10.0.0' });
    const affiliateCard = feed.json.cards.find((c) => c.id === 'explore-partner-hotels-tripcom');
    check('seeded Trip.com affiliate card is present', Boolean(affiliateCard), JSON.stringify(feed.json.cards.map((c) => c.id)));
    if (affiliateCard) {
      assertEqual('actionURL path', new URL(affiliateCard.actionURL).pathname, '/r/explore-partner-hotels-tripcom');
      check('actionURL host is THIS server, not trip.com', !affiliateCard.actionURL.includes('trip.com'), affiliateCard.actionURL);
      check('navigateTo is null on an affiliate card', affiliateCard.navigateTo === null, String(affiliateCard.navigateTo));
    }
    const firstPartyCard = feed.json.cards.find((c) => c.id === 'explore-plan-a-trip');
    check('a firstParty card has navigateTo set and actionURL null', Boolean(firstPartyCard) && firstPartyCard.actionURL === null && Boolean(firstPartyCard.navigateTo), JSON.stringify(firstPartyCard));

    // ---------------------------------------------------------------------------
    // 5. GET /r/:cardId — unknown id -> 404; known id -> 302 + a click gets recorded.
    // ---------------------------------------------------------------------------
    console.log('\n=== GET /r/:cardId ===');
    const unknownRedirect = await request(port, 'GET', '/r/does-not-exist', {});
    assertEqual('unknown card id -> 404', unknownRedirect.status, 404);
    check('404 body is plain text, not a redirect', !unknownRedirect.headers.location, JSON.stringify(unknownRedirect.headers));

    const clicksBefore = await request(port, 'GET', '/v1/admin/explore-clicks?since=2020-01-01T00:00:00.000Z', adminHeaders());
    const beforeCount = (clicksBefore.json.counts.find((c) => c.cardId === 'explore-partner-hotels-tripcom') || { clicks: 0 }).clicks;

    const goodRedirect = await request(port, 'GET', '/r/explore-partner-hotels-tripcom?region=TW', {});
    assertEqual('known affiliate card id -> 302', goodRedirect.status, 302);
    assertEqual('redirects to the stored target_url', goodRedirect.headers.location, 'https://www.trip.com/t/dp53V66kCW2');

    const clicksAfter = await request(port, 'GET', '/v1/admin/explore-clicks?since=2020-01-01T00:00:00.000Z', adminHeaders());
    const afterCount = (clicksAfter.json.counts.find((c) => c.cardId === 'explore-partner-hotels-tripcom') || { clicks: 0 }).clicks;
    assertEqual('a click was recorded for the card', afterCount, beforeCount + 1);

    // ---------------------------------------------------------------- navigateTo contract
    // `navigate_to` is a string the app resolves to one of its own screens, and nothing in JS or
    // SQL can type-check it. The app DROPS a card whose destination it can't parse, so an invalid
    // value has to fail at write time — otherwise the card just vanishes from Explore with no
    // error anywhere. (The shipped seed originally said "travelPlanner", which no AppSection
    // case matches.) See src/lib/exploreDestinations.js.
    console.log('\n=== navigateTo is validated against real app destinations ===');

    const badDestination = await createCard(port, {
      id: 'test-bad-destination-card',
      type: 'firstParty',
      category: 'travel',
      icon: 'airplane',
      navigateTo: 'travelPlanner',
      published: true,
      text: { en: { tag: 'T', title: 'T', description: 'D', ctaLabel: 'C' } },
    });
    assertEqual('navigateTo "travelPlanner" is rejected -> 400', badDestination.status, 400);
    check(
      'the 400 names the allowed destinations',
      JSON.stringify(badDestination.json || {}).includes('section.travel'),
      JSON.stringify(badDestination.json)
    );

    const goodDestination = await createCard(port, {
      id: 'test-good-destination-card',
      type: 'firstParty',
      category: 'travel',
      icon: 'airplane',
      navigateTo: 'section.travel',
      published: true,
      text: { en: { tag: 'T', title: 'T', description: 'D', ctaLabel: 'C' } },
    });
    testCardIds.push('test-good-destination-card');
    assertEqual('navigateTo "section.travel" is accepted -> 201', goodDestination.status, 201);

    const missingDestination = await createCard(port, {
      id: 'test-missing-destination-card',
      type: 'firstParty',
      category: 'travel',
      icon: 'airplane',
      published: true,
      text: { en: { tag: 'T', title: 'T', description: 'D', ctaLabel: 'C' } },
    });
    assertEqual('a firstParty card with no navigateTo is rejected -> 400', missingDestination.status, 400);

    const missingTarget = await createCard(port, {
      id: 'test-missing-target-card',
      type: 'affiliate',
      category: 'hotels',
      icon: 'building.2.fill',
      published: true,
      text: { en: { tag: 'T', title: 'T', description: 'D', ctaLabel: 'C' } },
    });
    assertEqual('an affiliate card with no targetUrl is rejected -> 400', missingTarget.status, 400);

    // ---------------------------------------------------------------- editorial cards
    // Until 25 Sep 2026 the feed only gave affiliate cards an actionURL, so an editorial card
    // reached the app with no action at all and the iOS client silently dropped it.
    console.log('\n=== editorial cards link out through /r/<id> ===');
    const editorialNoTarget = await createCard(port, {
      id: 'test-editorial-no-target', type: 'editorial', category: 'travel', icon: 'book',
      published: true, text: { en: { tag: 'T', title: 'T', description: 'D', ctaLabel: 'C' } },
    });
    assertEqual('an editorial card with no targetUrl is rejected -> 400', editorialNoTarget.status, 400);

    const editorial = await createCard(port, {
      id: 'test-editorial-card', type: 'editorial', category: 'travel', icon: 'book',
      targetUrl: 'https://plyndi.com/guides/taipei', published: true,
      text: { en: { tag: 'Guide', title: 'Taipei in 3 days', description: 'D', ctaLabel: 'Read' } },
    });
    testCardIds.push('test-editorial-card');
    assertEqual('an editorial card with a targetUrl is accepted -> 201', editorial.status, 201);

    const editorialFeed = await explore(port, '', clientHeaders());
    const editorialCard = (editorialFeed.json.cards || []).find((c) => c.id === 'test-editorial-card');
    check('the editorial card is served', Boolean(editorialCard), JSON.stringify(editorialCard));
    if (editorialCard) {
      check('editorial actionURL goes through /r/, not straight to the article',
        new URL(editorialCard.actionURL).pathname === '/r/test-editorial-card', editorialCard.actionURL);
      check('editorial navigateTo is null', editorialCard.navigateTo === null, String(editorialCard.navigateTo));
    }
    const editorialRedirect = await request(port, 'GET', '/r/test-editorial-card', {});
    assertEqual('editorial /r/<id> -> 302', editorialRedirect.status, 302);
    assertEqual('editorial redirects to its article', editorialRedirect.headers.location, 'https://plyndi.com/guides/taipei');

    // The seed is the thing that shipped broken, so assert the shipped values too, not just the
    // validator — a corrected validator with an uncorrected seed serves a card the app drops.
    const seedFeed = await explore(port, '', clientHeaders());
    const { isValidNavigateTo } = require('../src/lib/exploreDestinations');
    const seedFirstParty = (seedFeed.json.cards || []).filter((c) => c.navigateTo !== null);
    check('the seed has firstParty cards to check', seedFirstParty.length > 0, String(seedFirstParty.length));
    for (const card of seedFirstParty) {
      check(
        `seeded card "${card.id}" has a destination the app can parse (${card.navigateTo})`,
        isValidNavigateTo(card.navigateTo),
        card.navigateTo
      );
    }
  } finally {
    for (const id of testCardIds) {
      // eslint-disable-next-line no-await-in-loop
      await deleteCard(port, id);
    }
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  process.exitCode = failures === 0 ? 0 : 1;
  process.exit(process.exitCode);
}

main().catch((err) => {
  console.error('Test script crashed:', err);
  process.exitCode = 1;
  process.exit(1);
});
