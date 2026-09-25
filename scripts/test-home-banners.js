// Plain-Node smoke test for the Home banner carousel: GET /v1/content/home-banners,
// POST /v1/content/home-banners/impressions, GET /r/banner/:id, and /v1/admin/home-banners,
// /v1/admin/home-banner-stats and /v1/admin/translate. Same style as scripts/test-content.js — no
// framework, one in-process HTTP server, DATABASE_URL deliberately unset so this only exercises
// src/lib/store/memoryStore.js. The model provider is stubbed the way scripts/test-ai-run.js does
// it (replacing providerGateway.PROVIDERS entries in place) — nothing here reaches the network.
//
// Run: node scripts/test-home-banners.js   (or: npm run test:banners)

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
const IMPRESSIONS_LIMIT = 60;
process.env.CLIENT_SHARED_KEY = CLIENT_KEY;
delete process.env.DATABASE_URL;
delete process.env.ADMIN_TOKEN; // the first test needs it genuinely unset
for (const key of ['HOME_BANNER_INTERVAL_SECONDS', 'HOME_BANNER_ASPECT_RATIO', 'BANNER_IMAGE_HOSTS', 'PUBLIC_BASE_URL']) {
  delete process.env[key];
}
// This script makes far more feed requests than the general 60-an-hour limiter allows one IP;
// that limiter is not what is under test here. The impressions limiter is, so it gets a known max.
process.env.RATE_LIMIT_MAX = '100000';
process.env.HOME_BANNER_IMPRESSIONS_RATE_LIMIT_MAX = String(IMPRESSIONS_LIMIT);

const app = require('../src/server');
const store = require('../src/lib/store');
const providerGateway = require('../src/lib/providerGateway');

function request(port, method, reqPath, headers, body, { raw } = {}) {
  return new Promise((resolve, reject) => {
    const payload = raw !== undefined ? raw : (body !== undefined ? JSON.stringify(body) : undefined);
    const req = http.request(
      {
        port,
        path: reqPath,
        method,
        headers: Object.assign(payload !== undefined ? { 'content-type': 'application/json' } : {}, headers),
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => {
          let json = null;
          try { json = text ? JSON.parse(text) : null; } catch (_e) { /* not JSON */ }
          resolve({ status: res.statusCode, headers: res.headers, raw: text, json });
        });
      }
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const clientHeaders = (extra) => Object.assign({ 'X-Plyndi-Client-Key': CLIENT_KEY, 'X-Plyndi-Platform': 'ios' }, extra);
const adminHeaders = (extra) => Object.assign({ 'X-Admin-Token': process.env.ADMIN_TOKEN || '' }, extra);

const IMG = (name) => `https://cdn.plyndi.com/banners/${name}.jpg`;

// A valid firstParty banner (app-drawn text); override anything per test.
function banner(overrides = {}) {
  return Object.assign({
    id: 'test-banner',
    type: 'firstParty',
    position: 1,
    active: true,
    imageUrl: IMG('default'),
    navigateTo: 'section.travel',
    text: { en: { title: 'Plan your whole trip', subtitle: 'Itinerary and budget in one tap', ctaLabel: 'Try it', altText: 'Plan your whole trip with Plyndi' } },
  }, overrides);
}
function affiliate(overrides = {}) {
  return banner(Object.assign({
    type: 'affiliate', partnerName: 'Example Hotels', navigateTo: null, targetUrl: 'https://partner.example/hotels',
  }, overrides));
}

async function main() {
  const port = await new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server.address().port));
  });
  const feed = (query, headers) => request(port, 'GET', `/v1/content/home-banners${query || ''}`, clientHeaders(headers));
  const createBanner = (body) => request(port, 'POST', '/v1/admin/home-banners', adminHeaders(), body);
  const putBanner = (id, body) => request(port, 'PUT', `/v1/admin/home-banners/${id}`, adminHeaders(), body);
  const deleteBanner = (id) => request(port, 'DELETE', `/v1/admin/home-banners/${id}`, adminHeaders());
  const listAdmin = () => request(port, 'GET', '/v1/admin/home-banners', adminHeaders());
  const ids = (res) => ((res.json && res.json.banners) || []).map((b) => b.id);
  const find = (res, id) => ((res.json && res.json.banners) || []).find((b) => b.id === id);
  let impressionPosts = 0;
  // Counts the posts the impressions limiter sees. A body express.json() cannot parse is answered
  // by src/server.js's parse-error handler before the route (and its limiter) is ever reached.
  const postImpressions = (body, opts = {}) => {
    if (!opts.neverReachesRoute) impressionPosts += 1;
    return request(port, 'POST', '/v1/content/home-banners/impressions', opts.headers || clientHeaders(), body, opts);
  };

  const created = new Set();
  async function create(body) {
    const res = await createBanner(body);
    if (res.status === 201) created.add(body.id);
    return res;
  }
  async function removeAll() {
    for (const id of created) {
      // eslint-disable-next-line no-await-in-loop
      await deleteBanner(id);
    }
    created.clear();
  }

  try {
    // -------------------------------------------------------------------- auth
    console.log('\n=== ADMIN_TOKEN unset -> 503; the feed needs the client key ===');
    for (const [method, path] of [['GET', '/v1/admin/home-banners'], ['POST', '/v1/admin/home-banners'], ['GET', '/v1/admin/home-banner-stats'], ['POST', '/v1/admin/translate']]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(port, method, path, adminHeaders(), method === 'POST' ? {} : undefined);
      assertEqual(`${method} ${path} with no ADMIN_TOKEN configured -> 503`, res.status, 503);
    }
    assertEqual('feed without the client key -> 401', (await request(port, 'GET', '/v1/content/home-banners', {})).status, 401);
    assertEqual('impressions without the client key -> 401',
      (await request(port, 'POST', '/v1/content/home-banners/impressions', {}, { counts: {} })).status, 401);

    process.env.ADMIN_TOKEN = 'test-admin-token';
    assertEqual('wrong admin token -> 401',
      (await request(port, 'GET', '/v1/admin/home-banners', { 'X-Admin-Token': 'nope' })).status, 401);

    // -------------------------------------------------------------------- empty list
    console.log('\n=== empty list ===');
    const empty = await feed();
    assertEqual('empty feed -> 200', empty.status, 200);
    check('banners is an empty array', Array.isArray(empty.json.banners) && empty.json.banners.length === 0, empty.raw);
    assertEqual('intervalSeconds defaults to 4', empty.json.intervalSeconds, 4);
    assertEqual('aspectRatio defaults to 3.0', empty.json.aspectRatio, 3);
    check('response has exactly intervalSeconds, aspectRatio, banners',
      JSON.stringify(Object.keys(empty.json).sort()) === JSON.stringify(['aspectRatio', 'banners', 'intervalSeconds']), empty.raw);
    const adminEmpty = await listAdmin();
    assertEqual('admin list -> 200', adminEmpty.status, 200);
    const settings = adminEmpty.json.settings || {};
    check('admin list carries the settings the admin page previews against',
      settings.aspectRatio === 3 && settings.maxActive === 10 && settings.limits.title === 40
        && JSON.stringify(settings.imageHosts) === JSON.stringify(['cdn.plyndi.com', 'plyndi.com', 'www.plyndi.com'])
        && settings.locales.length === 12,
      JSON.stringify(settings));

    // -------------------------------------------------------------------- env settings
    console.log('\n=== intervalSeconds / aspectRatio from the environment ===');
    for (const [raw, expected] of [['1', 3], ['3', 3], ['7', 7], ['10', 10], ['99', 10], ['abc', 4], ['', 4]]) {
      process.env.HOME_BANNER_INTERVAL_SECONDS = raw;
      // eslint-disable-next-line no-await-in-loop
      assertEqual(`HOME_BANNER_INTERVAL_SECONDS=${JSON.stringify(raw)} -> ${expected}`, (await feed()).json.intervalSeconds, expected);
    }
    delete process.env.HOME_BANNER_INTERVAL_SECONDS;
    for (const [raw, expected] of [['3.647', 3.647], ['x', 3], ['-1', 3], ['0', 3]]) {
      process.env.HOME_BANNER_ASPECT_RATIO = raw;
      // eslint-disable-next-line no-await-in-loop
      assertEqual(`HOME_BANNER_ASPECT_RATIO=${JSON.stringify(raw)} -> ${expected}`, (await feed()).json.aspectRatio, expected);
    }
    delete process.env.HOME_BANNER_ASPECT_RATIO;

    // -------------------------------------------------------------------- contract + locale fallback
    console.log('\n=== contract and locale fallback to "en" ===');
    const localized = await create(banner({
      id: 'test-localized',
      position: 5,
      textTheme: 'dark',
      text: {
        en: { title: 'English title', subtitle: 'English subtitle', ctaLabel: 'Go', altText: 'English banner' },
        ja: { title: '日本語のタイトル', altText: '日本語のバナー' },
      },
    }));
    assertEqual('create a banner with en + ja -> 201', localized.status, 201);
    const enBanner = find(await feed('?locale=en'), 'test-localized');
    check('banner is served', Boolean(enBanner));
    if (enBanner) {
      check('banner has exactly the contract fields, in the documented order',
        JSON.stringify(Object.keys(enBanner)) === JSON.stringify(['id', 'type', 'partnerName', 'imageUrl', 'imageHasText', 'textTheme', 'title', 'subtitle', 'ctaLabel', 'altText', 'actionURL', 'navigateTo', 'requiresUpcomingTrip']),
        JSON.stringify(Object.keys(enBanner)));
      assertEqual('en title', enBanner.title, 'English title');
      assertEqual('textTheme passes through', enBanner.textTheme, 'dark');
      assertEqual('imageUrl is the default image', enBanner.imageUrl, IMG('default'));
      assertEqual('imageHasText defaults to false', enBanner.imageHasText, false);
      assertEqual('navigateTo passes through', enBanner.navigateTo, 'section.travel');
      assertEqual('a navigateTo banner has no actionURL', enBanner.actionURL, null);
      assertEqual('firstParty partnerName is null', enBanner.partnerName, null);
      assertEqual('requiresUpcomingTrip defaults to false', enBanner.requiresUpcomingTrip, false);
    }
    const jaBanner = find(await feed('?locale=ja'), 'test-localized');
    assertEqual('ja -> ja title', jaBanner && jaBanner.title, '日本語のタイトル');
    assertEqual('ja row with no subtitle -> subtitle null (no per-field mixing with en)', jaBanner && jaBanner.subtitle, null);
    const koBanner = find(await feed('?locale=ko'), 'test-localized');
    assertEqual('ko (no translation) -> the whole en row', koBanner && koBanner.title, 'English title');
    assertEqual('no ?locale -> en', find(await feed(), 'test-localized').title, 'English title');

    // -------------------------------------------------------------------- locales filter
    console.log('\n=== locales: only shown in the listed app languages ===');
    await create(banner({ id: 'test-ja-only', position: 6, locales: ['ja'] }));
    await create(banner({ id: 'test-cjk', position: 7, locales: ['ja', 'zh-Hant'] }));
    check('locales ["ja"] shown to ja', ids(await feed('?locale=ja')).includes('test-ja-only'));
    check('locales ["ja"] hidden from en', !ids(await feed('?locale=en')).includes('test-ja-only'));
    check('locales ["ja"] hidden when no locale is sent (the app default is en)', !ids(await feed()).includes('test-ja-only'));
    check('locales ["ja","zh-Hant"] shown to zh-Hant', ids(await feed('?locale=zh-Hant')).includes('test-cjk'));
    check('locales ["ja","zh-Hant"] hidden from zh-Hans', !ids(await feed('?locale=zh-Hans')).includes('test-cjk'));
    for (const locale of ['en', 'my', 'ar']) {
      // eslint-disable-next-line no-await-in-loop
      check(`locales null shown to ${locale}`, ids(await feed(`?locale=${locale}`)).includes('test-localized'));
    }

    // -------------------------------------------------------------------- visibility
    console.log('\n=== inactive, out-of-window and too-new banners are hidden ===');
    const day = 24 * 60 * 60 * 1000;
    await create(banner({ id: 'test-inactive', position: 2, active: false }));
    await create(banner({ id: 'test-future', position: 2, startsAt: new Date(Date.now() + day).toISOString() }));
    await create(banner({ id: 'test-ended', position: 2, endsAt: new Date(Date.now() - day).toISOString() }));
    await create(banner({ id: 'test-in-window', position: 3, startsAt: new Date(Date.now() - day).toISOString(), endsAt: new Date(Date.now() + day).toISOString() }));
    await create(banner({ id: 'test-new-app-only', position: 4, minAppVersion: '99.0' }));
    const visible = ids(await feed('', { 'X-Plyndi-App-Version': '1.0' }));
    check('inactive banner hidden', !visible.includes('test-inactive'), JSON.stringify(visible));
    check('not-yet-started banner hidden', !visible.includes('test-future'), JSON.stringify(visible));
    check('ended banner hidden', !visible.includes('test-ended'), JSON.stringify(visible));
    check('banner inside its window shown', visible.includes('test-in-window'), JSON.stringify(visible));
    check('minAppVersion 99.0 hidden from app 1.0', !visible.includes('test-new-app-only'), JSON.stringify(visible));
    check('minAppVersion fails OPEN when the app sends no version', ids(await feed()).includes('test-new-app-only'));
    check('minAppVersion 99.0 shown to app 99.1', ids(await feed('', { 'X-Plyndi-App-Version': '99.1' })).includes('test-new-app-only'));

    // -------------------------------------------------------------------- order
    console.log('\n=== ordered by position ===');
    await create(banner({ id: 'test-first', position: 0 }));
    assertEqual('position ascending',
      JSON.stringify(ids(await feed('?locale=en'))),
      JSON.stringify(['test-first', 'test-in-window', 'test-new-app-only', 'test-localized']));
    assertEqual('PUT to move a banner -> 200', (await putBanner('test-first', banner({ id: 'test-first', position: 9 }))).status, 200);
    assertEqual('moved banner is now last', ids(await feed('?locale=en')).at(-1), 'test-first');

    // -------------------------------------------------------------------- ETag
    console.log('\n=== ETag / If-None-Match ===');
    const first = await feed();
    const second = await feed();
    check('ETag present', Boolean(first.headers.etag));
    assertEqual('identical request -> identical ETag', first.headers.etag, second.headers.etag);
    check('Cache-Control max-age set', /max-age=\d+/.test(first.headers['cache-control'] || ''), first.headers['cache-control']);
    assertEqual('If-None-Match with matching ETag -> 304', (await feed('', { 'If-None-Match': first.headers.etag })).status, 304);
    assertEqual('If-None-Match with a stale ETag -> 200', (await feed('', { 'If-None-Match': '"stale"' })).status, 200);
    check('different locale -> different ETag', (await feed('?locale=ja')).headers.etag !== first.headers.etag);

    // -------------------------------------------------------------------- imageHasText
    console.log('\n=== imageHasText: no text fields, per-locale image override ===');
    const textImage = await create(banner({
      id: 'test-text-image',
      position: 8,
      imageHasText: true,
      imageUrl: IMG('drawn-en'),
      text: {
        en: { altText: 'Plyndi: money, tasks and trips' },
        ja: { altText: 'Plyndi 日本語', imageUrl: IMG('drawn-ja') },
        de: { altText: 'Plyndi auf Deutsch' },
      },
    }));
    assertEqual('imageHasText banner with only alt text -> 201 (no title needed)', textImage.status, 201);
    const drawnEn = find(await feed('?locale=en'), 'test-text-image');
    check('imageHasText -> title, subtitle, ctaLabel are null',
      drawnEn && drawnEn.title === null && drawnEn.subtitle === null && drawnEn.ctaLabel === null, JSON.stringify(drawnEn));
    assertEqual('imageHasText is true in the response', drawnEn && drawnEn.imageHasText, true);
    assertEqual('en -> default image', drawnEn && drawnEn.imageUrl, IMG('drawn-en'));
    assertEqual('ja -> ja override image', (find(await feed('?locale=ja'), 'test-text-image') || {}).imageUrl, IMG('drawn-ja'));
    assertEqual('de row without override -> default image', (find(await feed('?locale=de'), 'test-text-image') || {}).imageUrl, IMG('drawn-en'));
    assertEqual('de alt text is its own', (find(await feed('?locale=de'), 'test-text-image') || {}).altText, 'Plyndi auf Deutsch');
    assertEqual('ko (no row) -> en row -> default image', (find(await feed('?locale=ko'), 'test-text-image') || {}).imageUrl, IMG('drawn-en'));
    const withTitles = await putBanner('test-text-image', banner({ id: 'test-text-image', position: 8, imageHasText: true, imageUrl: IMG('drawn-en') }));
    assertEqual('imageHasText with titles stored -> 200', withTitles.status, 200);
    assertEqual('...but titles are never served while imageHasText is true', (find(await feed(), 'test-text-image') || {}).title, null);

    // -------------------------------------------------------------------- validation
    console.log('\n=== every validation rule -> 400 with a readable message ===');
    const en = (fields) => ({ en: Object.assign({ title: 'T', altText: 'Alt' }, fields) });
    const rejects = [
      ['imageUrl missing', banner({ id: 'v1', imageUrl: undefined }), /"imageUrl" is required/],
      ['http:// imageUrl', banner({ id: 'v2', imageUrl: 'http://cdn.plyndi.com/b.jpg' }), /"imageUrl" must be https/],
      ['imageUrl on a host not in BANNER_IMAGE_HOSTS', banner({ id: 'v3', imageUrl: 'https://images.example.com/b.jpg' }), /must be hosted on one of/],
      ['look-alike host evil-plyndi.com', banner({ id: 'v4', imageUrl: 'https://evil-plyndi.com/b.jpg' }), /must be hosted on one of/],
      ['look-alike host plyndi.com.evil.net', banner({ id: 'v5', imageUrl: 'https://plyndi.com.evil.net/b.jpg' }), /must be hosted on one of/],
      ['per-locale image override off the allowlist', banner({ id: 'v6', imageHasText: true, text: { en: { altText: 'A' }, ja: { altText: 'A', imageUrl: 'https://example.com/ja.jpg' } } }), /text\.ja\.imageUrl must be hosted/],
      ['per-locale image override over http', banner({ id: 'v7', imageHasText: true, text: { en: { altText: 'A' }, ja: { altText: 'A', imageUrl: 'http://cdn.plyndi.com/ja.jpg' } } }), /text\.ja\.imageUrl must be https/],
      ['no en row', banner({ id: 'v8', text: { ja: { title: 'T', altText: 'A' } } }), /"text\.en" is required/],
      ['no text at all', banner({ id: 'v9', text: undefined }), /"text" must be an object/],
      ['missing alt text', banner({ id: 'v10', text: { en: { title: 'T' } } }), /altText must be 1–120/],
      ['whitespace-only alt text', banner({ id: 'v11', text: en({ altText: '   ' }) }), /altText must be 1–120/],
      ['121-character alt text', banner({ id: 'v12', text: en({ altText: 'x'.repeat(121) }) }), /altText must be 1–120/],
      ['en title missing when the image has no text', banner({ id: 'v13', text: { en: { altText: 'A' } } }), /text\.en\.title is required when the image has no text/],
      ['a locale row with no title when the image has no text', banner({ id: 'v14', text: { en: { title: 'T', altText: 'A' }, ja: { altText: 'A' } } }), /text\.ja\.title is required/],
      ['41-character title', banner({ id: 'v15', text: en({ title: 't'.repeat(41) }) }), /text\.en\.title is 41 characters; the limit is 40/],
      ['81-character subtitle', banner({ id: 'v16', text: en({ subtitle: 's'.repeat(81) }) }), /text\.en\.subtitle is 81 characters; the limit is 80/],
      ['21-character CTA', banner({ id: 'v17', text: en({ ctaLabel: 'c'.repeat(21) }) }), /text\.en\.ctaLabel is 21 characters; the limit is 20/],
      ['affiliate with no targetUrl', affiliate({ id: 'v18', targetUrl: null }), /"affiliate" banner must carry a "targetUrl"/],
      ['affiliate with no partnerName', affiliate({ id: 'v19', partnerName: null }), /"affiliate" banner must carry a "partnerName"/],
      ['61-character partnerName', affiliate({ id: 'v20', partnerName: 'p'.repeat(61) }), /"partnerName" is 61 characters/],
      ['http:// targetUrl', affiliate({ id: 'v21', targetUrl: 'http://partner.example/x' }), /"targetUrl" must be null or a full https/],
      ['targetUrl that is not a URL', affiliate({ id: 'v22', targetUrl: 'trip.com' }), /"targetUrl" must be null or a full https/],
      ['both targetUrl and navigateTo', banner({ id: 'v23', targetUrl: 'https://plyndi.com/x', navigateTo: 'aiHub' }), /never both/],
      ['navigateTo "travelPlanner"', banner({ id: 'v24', navigateTo: 'travelPlanner' }), /"navigateTo" must be null or one of/],
      ['locales with a code the app does not use', banner({ id: 'v25', locales: ['ja', 'pt'] }), /"locales" has codes the app does not use: pt/],
      ['locales "zh-TW" (the app sends zh-Hant)', banner({ id: 'v26', locales: ['zh-TW'] }), /does not use: zh-TW/],
      ['locales as an empty list', banner({ id: 'v27', locales: [] }), /"locales" must be null \(every language\) or a non-empty list/],
      ['locales listing a language twice', banner({ id: 'v28', locales: ['ja', 'ja'] }), /lists a language twice/],
      ['a text row for a locale the app does not use', banner({ id: 'v29', text: { en: { title: 'T', altText: 'A' }, pt: { title: 'T', altText: 'A' } } }), /text\.pt: "pt" is not an app language/],
      ['a "price" field', banner({ id: 'v30', price: 'NT$1,200' }), /never carry a price, rating, discount, badge or deal/],
      ['a "deal" field', banner({ id: 'v31', deal: 'Save 20%' }), /never carry a price, rating, discount, badge or deal/],
      ['"rating" inside a locale', banner({ id: 'v32', text: en({ rating: 5 }) }), /text\.en: unknown field\(s\): rating/],
      ['"discountPercent" field', banner({ id: 'v33', discountPercent: 20 }), /never carry a price/],
      ['a "badge" field', banner({ id: 'v34', badge: 'HOT' }), /never carry a price/],
      ['an unknown non-offer field', banner({ id: 'v35', headline: 'x' }), /unknown field\(s\): headline/],
      ['id with a space', banner({ id: 'bad id' }), /"id" must be/],
      ['unknown type', banner({ id: 'v36', type: 'sponsored' }), /"type" must be one of firstParty, affiliate/],
      ['unknown textTheme', banner({ id: 'v37', textTheme: 'blue' }), /"textTheme" must be "light"/],
      ['imageHasText as a string', banner({ id: 'v38', imageHasText: 'yes' }), /"imageHasText" must be a boolean/],
      ['requiresUpcomingTrip as a number', banner({ id: 'v39', requiresUpcomingTrip: 1 }), /"requiresUpcomingTrip" must be a boolean/],
      ['fractional position', banner({ id: 'v40', position: 1.5 }), /"position" must be a whole number/],
      ['active as a string', banner({ id: 'v41', active: 'yes' }), /"active" must be a boolean/],
      ['endsAt before startsAt', banner({ id: 'v42', startsAt: '2026-10-02T00:00:00Z', endsAt: '2026-10-01T00:00:00Z' }), /"endsAt" must be after "startsAt"/],
      ['unparseable startsAt', banner({ id: 'v43', startsAt: 'next tuesday' }), /"startsAt" must be null or an ISO date/],
      ['minAppVersion "1.x"', banner({ id: 'v44', minAppVersion: '1.x' }), /"minAppVersion" must be null or a version/],
    ];
    for (const [label, body, pattern] of rejects) {
      // eslint-disable-next-line no-await-in-loop
      const res = await createBanner(body);
      const details = (res.json && res.json.details) || [];
      check(`${label} -> 400`, res.status === 400 && res.json.error === 'invalid_payload' && details.some((d) => pattern.test(d)),
        `${res.status} ${JSON.stringify(details)}`);
    }

    const accepts = [
      ['40-character title, 80 subtitle, 20 CTA, 120 alt', banner({ id: 'ok-limits', active: false, text: en({ title: 't'.repeat(40), subtitle: 's'.repeat(80), ctaLabel: 'c'.repeat(20), altText: 'a'.repeat(120) }) })],
      ['limits count characters, not bytes: 40 Burmese syllables', banner({ id: 'ok-burmese', active: false, text: { en: { title: 'T', altText: 'A' }, my: { title: 'ကြို'.repeat(40), altText: 'A' } } })],
      ['a banner with neither action (not tappable)', banner({ id: 'ok-no-action', active: false, navigateTo: null })],
      ['a firstParty banner that opens an https URL', banner({ id: 'ok-first-party-url', active: false, navigateTo: null, targetUrl: 'https://plyndi.com/new' })],
      ['navigateTo "aiHub"', banner({ id: 'ok-ai-hub', active: false, navigateTo: 'aiHub' })],
      ['an image on www.plyndi.com', banner({ id: 'ok-www', active: false, imageUrl: 'https://www.plyndi.com/b.png' })],
      ['uppercase host CDN.PLYNDI.COM', banner({ id: 'ok-upper-host', active: false, imageUrl: 'https://CDN.PLYNDI.COM/b.png' })],
      ['every one of the 12 app locales', banner({ id: 'ok-all-locales', active: false, locales: ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'my', 'th', 'vi', 'ar', 'es', 'de', 'fr'] })],
      ['a valid affiliate with requiresUpcomingTrip', affiliate({ id: 'ok-affiliate', active: false, requiresUpcomingTrip: true })],
    ];
    for (const [label, body] of accepts) {
      // eslint-disable-next-line no-await-in-loop
      assertEqual(`${label} -> 201`, (await create(body)).status, 201);
    }
    assertEqual('creating an existing id -> 409', (await createBanner(banner({ id: 'ok-www', active: false }))).status, 409);
    assertEqual('PUT body id != URL id -> 400', (await putBanner('ok-www', banner({ id: 'something-else' }))).status, 400);
    assertEqual('PUT is validated too (price field) -> 400', (await putBanner('ok-www', banner({ id: 'ok-www', price: 1 }))).status, 400);

    console.log('\n=== BANNER_IMAGE_HOSTS is read from the environment ===');
    process.env.BANNER_IMAGE_HOSTS = 'images.example.com';
    assertEqual('a host added to BANNER_IMAGE_HOSTS is accepted',
      (await create(banner({ id: 'ok-custom-host', active: false, imageUrl: 'https://images.example.com/b.jpg' }))).status, 201);
    assertEqual('cdn.plyndi.com is refused once the list no longer has it', (await createBanner(banner({ id: 'v-cdn-refused', active: false }))).status, 400);
    delete process.env.BANNER_IMAGE_HOSTS;

    // -------------------------------------------------------------------- redirect + clicks
    console.log('\n=== GET /r/banner/:id ===');
    await create(affiliate({ id: 'test-affiliate', position: 6 }));
    const aff = find(await feed(), 'test-affiliate');
    check('affiliate banner is served', Boolean(aff));
    if (aff) {
      assertEqual('actionURL is our own /r/banner/<id>, never the partner URL', new URL(aff.actionURL).pathname, '/r/banner/test-affiliate');
      check('actionURL does not leak the partner host', !aff.actionURL.includes('partner.example'), aff.actionURL);
      assertEqual('an actionURL banner has no navigateTo', aff.navigateTo, null);
      assertEqual('partnerName is served', aff.partnerName, 'Example Hotels');
    }
    const redirect = await request(port, 'GET', '/r/banner/test-affiliate?region=TW&appVersion=1.0', {});
    assertEqual('/r/banner/<id> -> 302 with no client key', redirect.status, 302);
    assertEqual('redirects to the stored target URL', redirect.headers.location, 'https://partner.example/hotels');
    const statsAfterClick = await request(port, 'GET', '/v1/admin/home-banner-stats', adminHeaders());
    assertEqual('the click is recorded against the banner',
      ((statsAfterClick.json.stats || []).find((s) => s.bannerId === 'test-affiliate') || {}).clicks, 1);
    assertEqual('/r/banner/<id> for a navigateTo banner -> 404', (await request(port, 'GET', '/r/banner/test-first', {})).status, 404);
    assertEqual('/r/banner/<unknown> -> 404', (await request(port, 'GET', '/r/banner/no-such-banner', {})).status, 404);

    console.log('\n=== an Explore card and a banner with the SAME id ===');
    const sharedId = 'test-shared-id';
    const card = await request(port, 'POST', '/v1/admin/explore-cards', adminHeaders(), {
      id: sharedId, type: 'affiliate', category: 'hotels', icon: 'building.2.fill', published: false,
      targetUrl: 'https://partner.example/card-target',
      text: { en: { tag: 'T', title: 'Card', description: 'D', ctaLabel: 'Go' } },
    });
    assertEqual('create the Explore card -> 201', card.status, 201);
    assertEqual('create the banner with the same id -> 201',
      (await create(affiliate({ id: sharedId, active: false, targetUrl: 'https://partner.example/banner-target' }))).status, 201);
    assertEqual('/r/<id> -> the CARD target', (await request(port, 'GET', `/r/${sharedId}`, {})).headers.location, 'https://partner.example/card-target');
    assertEqual('/r/banner/<id> -> the BANNER target', (await request(port, 'GET', `/r/banner/${sharedId}`, {})).headers.location, 'https://partner.example/banner-target');
    const exploreClicks = await request(port, 'GET', '/v1/admin/explore-clicks', adminHeaders());
    const bannerStats = await request(port, 'GET', '/v1/admin/home-banner-stats', adminHeaders());
    assertEqual('the card tap counts once, in explore-clicks', ((exploreClicks.json.counts || []).find((c) => c.cardId === sharedId) || {}).clicks, 1);
    assertEqual('the banner tap counts once, in home-banner-stats', ((bannerStats.json.stats || []).find((c) => c.bannerId === sharedId) || {}).clicks, 1);
    const literal = await request(port, 'POST', '/v1/admin/explore-cards', adminHeaders(), {
      id: 'banner', type: 'affiliate', category: 'hotels', icon: 'building.2.fill', published: false,
      targetUrl: 'https://partner.example/card-called-banner',
      text: { en: { tag: 'T', title: 'Card', description: 'D', ctaLabel: 'Go' } },
    });
    assertEqual('an Explore card whose id is literally "banner" can be created', literal.status, 201);
    assertEqual('/r/banner still reaches that Explore card', (await request(port, 'GET', '/r/banner', {})).headers.location, 'https://partner.example/card-called-banner');
    await request(port, 'DELETE', '/v1/admin/explore-cards/banner', adminHeaders());
    await request(port, 'DELETE', `/v1/admin/explore-cards/${sharedId}`, adminHeaders());

    // -------------------------------------------------------------------- impressions
    console.log('\n=== POST /v1/content/home-banners/impressions ===');
    const today = new Date().toISOString().slice(0, 10);
    const impressionsFor = async (id) => {
      const res = await request(port, 'GET', `/v1/admin/home-banner-stats?from=${today}&to=${today}`, adminHeaders());
      return ((res.json.stats || []).find((s) => s.bannerId === id) || {}).impressions || 0;
    };
    const one = await postImpressions({ counts: { 'test-affiliate': 5, 'test-localized': 2 } });
    assertEqual('valid body -> 204', one.status, 204);
    assertEqual('204 has no body', one.raw, '');
    await postImpressions({ counts: { 'test-affiliate': 3 } });
    assertEqual('two posts aggregate into today\'s row (5 + 3)', await impressionsFor('test-affiliate'), 8);
    assertEqual('the other banner counted too', await impressionsFor('test-localized'), 2);
    const unknown = await postImpressions({ counts: { 'no-such-banner': 4, 'test-localized': 1 } });
    assertEqual('a body with an unknown id -> 204', unknown.status, 204);
    assertEqual('...the known id in it is still counted', await impressionsFor('test-localized'), 3);
    assertEqual('...the unknown id is not stored', await impressionsFor('no-such-banner'), 0);

    const before = await impressionsFor('test-affiliate');
    const badBodies = [
      ['malformed JSON', undefined, { raw: '{"counts": {"test-affiliate": 5', neverReachesRoute: true }],
      ['JSON null (express.json strict mode refuses it)', undefined, { raw: 'null', neverReachesRoute: true }],
      ['an array', [1, 2]],
      ['no counts', { views: { 'test-affiliate': 1 } }],
      ['counts as an array', { counts: [['test-affiliate', 1]] }],
      ['empty counts', { counts: {} }],
      ['a count of 0', { counts: { 'test-affiliate': 0 } }],
      ['a count of 51', { counts: { 'test-affiliate': 51 } }],
      ['a negative count', { counts: { 'test-affiliate': -3 } }],
      ['a fractional count', { counts: { 'test-affiliate': 1.5 } }],
      ['a count as a string', { counts: { 'test-affiliate': '5' } }],
      ['11 entries', { counts: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`id-${i}`, 1])) }],
      ['a valid entry next to an invalid one', { counts: { 'test-affiliate': 5, 'test-localized': 999 } }],
      ['an id with a space', { counts: { 'bad id': 1, 'test-affiliate': 1 } }],
      ['a body over the 1 MB JSON limit', undefined, { raw: JSON.stringify({ counts: { 'test-affiliate': 1 }, pad: 'x'.repeat(1024 * 1024 + 10) }), neverReachesRoute: true }],
    ];
    for (const [label, body, opts] of badBodies) {
      // eslint-disable-next-line no-await-in-loop
      const res = await postImpressions(body, opts || {});
      check(`${label} -> 204 (never a 500)`, res.status === 204, `${res.status} ${res.raw.slice(0, 120)}`);
    }
    assertEqual('none of the bad bodies stored anything', await impressionsFor('test-affiliate'), before);

    // The limiter drops, it does not refuse: over the limit is still 204, and nothing is stored.
    const remaining = IMPRESSIONS_LIMIT - impressionPosts;
    for (let i = 0; i < remaining + 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const res = await postImpressions({ counts: { 'test-in-window': 1 } });
      if (res.status !== 204) check('rate-limited impressions are still 204', false, String(res.status));
    }
    assertEqual(`over the per-IP limit (${IMPRESSIONS_LIMIT} per 5 min) -> 204 and dropped`, await impressionsFor('test-in-window'), remaining);

    // -------------------------------------------------------------------- stats
    console.log('\n=== GET /v1/admin/home-banner-stats ===');
    const stats = await request(port, 'GET', `/v1/admin/home-banner-stats?from=${today}&to=${today}`, adminHeaders());
    assertEqual('stats -> 200', stats.status, 200);
    const affStats = (stats.json.stats || []).find((s) => s.bannerId === 'test-affiliate');
    check('affiliate: 8 impressions, 1 click, CTR 0.125',
      affStats && affStats.impressions === 8 && affStats.clicks === 1 && affStats.ctr === 0.125, JSON.stringify(affStats));
    const idle = (stats.json.stats || []).find((s) => s.bannerId === 'ok-no-action');
    check('a banner with no impressions is listed with zeros and CTR null',
      idle && idle.impressions === 0 && idle.clicks === 0 && idle.ctr === null, JSON.stringify(idle));
    const yesterday = new Date(Date.now() - day).toISOString().slice(0, 10);
    const past = await request(port, 'GET', `/v1/admin/home-banner-stats?from=${yesterday}&to=${yesterday}`, adminHeaders());
    assertEqual('a range that excludes today has none of today\'s impressions',
      ((past.json.stats || []).find((s) => s.bannerId === 'test-affiliate') || {}).impressions, 0);
    const defaults = await request(port, 'GET', '/v1/admin/home-banner-stats', adminHeaders());
    assertEqual('no from/to -> the last 30 days ending today', defaults.json.to, today);
    assertEqual('...starting 29 days earlier', defaults.json.from, new Date(Date.now() - 29 * day).toISOString().slice(0, 10));
    for (const [label, query] of [['from after to', `?from=${today}&to=${yesterday}`], ['a non-date', '?from=last-week'], ['an impossible date', '?from=2026-02-30&to=2026-03-01'], ['more than 366 days', '?from=2024-01-01&to=2026-01-01']]) {
      // eslint-disable-next-line no-await-in-loop
      assertEqual(`stats with ${label} -> 400`, (await request(port, 'GET', `/v1/admin/home-banner-stats${query}`, adminHeaders())).status, 400);
    }

    // -------------------------------------------------------------------- translate
    console.log('\n=== POST /v1/admin/translate (stubbed gateway, never saves) ===');
    const originalProviders = { ...providerGateway.PROVIDERS };
    const calls = [];
    let reply = null;
    const stub = async (args) => {
      calls.push(args);
      if (reply instanceof Error) throw reply;
      return typeof reply === 'function' ? reply(args) : reply;
    };
    providerGateway.PROVIDERS.openai = stub;
    providerGateway.PROVIDERS.gemini = stub;
    providerGateway.breakers.clear();
    const translate = (body) => request(port, 'POST', '/v1/admin/translate', adminHeaders(), body);
    try {
      const storeBefore = JSON.stringify(await store.listAllHomeBanners());
      reply = JSON.stringify({
        translations: [
          { locale: 'ja', title: 'AIで旅の計画を丸ごと', altText: 'Plyndi の AI 旅行プランナー' },
          { locale: 'de', title: 'Plane deine ganze Reise mit künstlicher Intelligenz', altText: 'Der KI-Reiseplaner von Plyndi' },
          { locale: 'xx', title: 'ignored', altText: 'ignored' },
        ],
      });
      const res = await translate({ source: { title: 'Plan your whole trip with AI', altText: 'Plyndi AI trip planner' }, locales: ['ja', 'de', 'my'] });
      assertEqual('translate -> 200', res.status, 200);
      assertEqual('ja title returned', res.json.translations.ja.title, 'AIで旅の計画を丸ごと');
      const longDe = res.json.translations.de.title;
      assertEqual('an over-long translation is returned WHOLE, not truncated', longDe, 'Plane deine ganze Reise mit künstlicher Intelligenz');
      check('...and flagged', res.json.problems.some((p) => p.locale === 'de' && p.field === 'title' && /51 characters; the limit is 40/.test(p.message)), JSON.stringify(res.json.problems));
      check('a locale the model skipped is flagged', res.json.problems.some((p) => p.locale === 'my' && p.field === null), JSON.stringify(res.json.problems));
      check('a locale nobody asked for is ignored', !('xx' in res.json.translations));
      check('only the fields given in English were requested (no subtitle/cta)',
        Object.keys(calls[0].jsonSchema.properties.translations.items.properties).join(',') === 'locale,title,altText',
        JSON.stringify(calls[0].jsonSchema));
      check('the prompt states the length limits', /title at most 40 characters/.test(calls[0].system) && /altText at most 120 characters/.test(calls[0].system), calls[0].system);
      check('the prompt forbids adding prices or deals', /no prices, discounts, ratings, badges, deals/.test(calls[0].system));
      check('the English source and target languages are sent', /Plan your whole trip with AI/.test(calls[0].user) && /Burmese/.test(calls[0].user), calls[0].user);
      assertEqual('translate saved nothing', JSON.stringify(await store.listAllHomeBanners()), storeBefore);

      reply = 'not json at all';
      assertEqual('model returns non-JSON -> 502', (await translate({ source: { title: 'Hi' }, locales: ['ja'] })).status, 502);
      reply = new providerGateway.ProviderError(401, 'bad key');
      const down = await translate({ source: { title: 'Hi' }, locales: ['ja'] });
      assertEqual('every provider fails -> 503', down.status, 503);
      check('...with a readable message that suggests translating by hand', /translate by hand/.test(down.json.error), down.raw);
      providerGateway.breakers.clear();

      const badRequests = [
        ['"en" as a target', { source: { title: 'Hi' }, locales: ['en'] }],
        ['an unknown locale', { source: { title: 'Hi' }, locales: ['pt'] }],
        ['no locales', { source: { title: 'Hi' }, locales: [] }],
        ['an empty source', { source: {}, locales: ['ja'] }],
        ['a source title over 40', { source: { title: 't'.repeat(41) }, locales: ['ja'] }],
        ['an unknown source field', { source: { title: 'Hi', price: '5' }, locales: ['ja'] }],
      ];
      const callsBefore = calls.length;
      for (const [label, body] of badRequests) {
        // eslint-disable-next-line no-await-in-loop
        assertEqual(`translate with ${label} -> 400`, (await translate(body)).status, 400);
      }
      assertEqual('...and none of them reached the model', calls.length, callsBefore);
      assertEqual('still nothing saved', JSON.stringify(await store.listAllHomeBanners()), storeBefore);
    } finally {
      Object.assign(providerGateway.PROVIDERS, originalProviders);
      providerGateway.breakers.clear();
    }

    // -------------------------------------------------------------------- limit + warnings
    // Start from a clean set so the counts below are exact.
    await removeAll();
    console.log('\n=== at most 10 active banners ===');
    for (let i = 1; i <= 10; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await create(banner({ id: `fill-${i}`, position: i }));
    }
    const eleventh = await createBanner(banner({ id: 'fill-11', position: 11 }));
    check('an 11th active banner (POST) -> 400', eleventh.status === 400 && eleventh.json.details.some((d) => /at most 10 banners can be active/.test(d)), eleventh.raw);
    assertEqual('the same banner inactive -> 201', (await create(banner({ id: 'fill-11', position: 11, active: false }))).status, 201);
    assertEqual('activating it with PUT while 10 are active -> 400', (await putBanner('fill-11', banner({ id: 'fill-11', position: 11 }))).status, 400);
    assertEqual('editing an already-active banner at the limit is still allowed -> 200', (await putBanner('fill-1', banner({ id: 'fill-1', position: 1 }))).status, 200);
    assertEqual('the feed serves exactly 10', ids(await feed()).length, 10);
    await removeAll();

    console.log('\n=== the feed itself never serves more than 10 ===');
    // The API can never make 11 active, but a row written any other way must still not put more
    // than 10 into the app.
    for (let i = 0; i < 12; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await store.upsertHomeBanner(Object.assign(banner({ id: `cap-${i}`, position: i }), { imageHasText: false }));
    }
    assertEqual('12 active rows written directly -> the feed serves 10', ids(await feed()).length, 10);
    for (let i = 0; i < 12; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await store.deleteHomeBanner(`cap-${i}`);
    }

    console.log('\n=== warnings (returned, never blocking) ===');
    const firstAff = await create(affiliate({ id: 'w-aff-1', position: 1 }));
    assertEqual('an affiliate banner first with no first-party active -> still 201', firstAff.status, 201);
    check('...with a warning about it', (firstAff.json.warnings || []).some((w) => /first in the carousel and no first-party banner is active/.test(w)), JSON.stringify(firstAff.json.warnings));
    const fp = await create(banner({ id: 'w-first-party', position: 5 }));
    check('adding an active first-party banner clears that warning', !(fp.json.warnings || []).some((w) => /no first-party/.test(w)), JSON.stringify(fp.json.warnings));
    await create(affiliate({ id: 'w-aff-2', position: 2 }));
    const third = await create(affiliate({ id: 'w-aff-3', position: 3 }));
    assertEqual('a 3rd active affiliate -> still 201', third.status, 201);
    check('...with a warning about more than 2 affiliates', (third.json.warnings || []).some((w) => /3 affiliate banners are active/.test(w)), JSON.stringify(third.json.warnings));
    check('GET /v1/admin/home-banners reports the same warnings', ((await listAdmin()).json.warnings || []).some((w) => /3 affiliate banners are active/.test(w)));
    const off = await putBanner('w-aff-3', affiliate({ id: 'w-aff-3', position: 3, active: false }));
    check('deactivating one clears it', !(off.json.warnings || []).some((w) => /affiliate banners are active/.test(w)), JSON.stringify(off.json.warnings));
    const noWarnings = await putBanner('w-first-party', banner({ id: 'w-first-party', position: 5 }));
    check('with 2 affiliates and a first-party active there are no warnings', (noWarnings.json.warnings || []).length === 0, JSON.stringify(noWarnings.json.warnings));

    // -------------------------------------------------------------------- delete
    console.log('\n=== DELETE ===');
    assertEqual('DELETE an existing banner -> 200', (await deleteBanner('w-aff-2')).status, 200);
    created.delete('w-aff-2');
    assertEqual('DELETE it again -> 404', (await deleteBanner('w-aff-2')).status, 404);
    check('click and impression history survives deleting the banner',
      ((await request(port, 'GET', `/v1/admin/home-banner-stats?from=${today}&to=${today}`, adminHeaders())).json.stats || [])
        .some((s) => s.bannerId === 'test-affiliate' && s.impressions === 8 && s.clicks === 1));

    // -------------------------------------------------------------------- store failure
    console.log('\n=== a store failure is a 200 with an empty list, never a 500 ===');
    const originalList = store.listHomeBanners;
    const originalRecord = store.recordHomeBannerImpressions;
    store.listHomeBanners = async () => { throw new Error('simulated database outage'); };
    store.recordHomeBannerImpressions = async () => { throw new Error('simulated database outage'); };
    const origError = console.error;
    console.error = () => {};
    let failed;
    let failedPost;
    try {
      failed = await feed();
      failedPost = await request(port, 'POST', '/v1/content/home-banners/impressions', clientHeaders({ 'X-Forwarded-For': '203.0.113.9' }), { counts: { 'w-aff-1': 1 } });
    } finally {
      store.listHomeBanners = originalList;
      store.recordHomeBannerImpressions = originalRecord;
      console.error = origError;
    }
    assertEqual('feed store failure -> 200', failed.status, 200);
    check('...with empty banners and real settings', failed.json && failed.json.banners.length === 0 && failed.json.intervalSeconds === 4, failed.raw);
    assertEqual('impressions store failure -> 204', failedPost.status, 204);

    // -------------------------------------------------------------------- seed
    console.log('\n=== the shipped seed ===');
    const seed = require('../src/config/home-banners-seed.json');
    const seedBanner = seed.banners[0];
    assertEqual('seed has one banner', seed.banners.length, 1);
    assertEqual('seed banner id', seedBanner.id, 'plyndi-placeholder-01');
    assertEqual('seed image has its text drawn in', seedBanner.imageHasText, true);
    // Through the admin validator: a seed that bypasses the rules is how the Explore seed once
    // shipped a card the app dropped.
    const seedThroughApi = await createBanner(Object.assign({}, seedBanner, { id: 'seed-check', active: false }));
    assertEqual('the seed banner passes the admin validator', seedThroughApi.status, 201);
    await deleteBanner('seed-check');
    // Idempotent: upserting twice leaves one banner with one text row.
    await store.upsertHomeBanner(seedBanner);
    await store.upsertHomeBanner(seedBanner);
    const seeded = (await store.listAllHomeBanners()).filter((b) => b.id === 'plyndi-placeholder-01');
    check('seeding twice -> one banner, one text row', seeded.length === 1 && Object.keys(seeded[0].text).length === 1, JSON.stringify(seeded));
    await store.deleteHomeBanner('plyndi-placeholder-01');

    // ---------------------------------------------------------------- degraded vs. real empty
    console.log('\n=== an internal error is marked degraded; all banners switched off is not ===');
    const realListHomeBanners = store.listHomeBanners;
    try {
      store.listHomeBanners = async () => [];
      const empty = await feed();
      check('all banners off -> 200 with an empty list', empty.status === 200 && empty.json.banners.length === 0, empty.raw.slice(0, 200));
      assertEqual('all banners off carries no degraded header', empty.headers['x-plyndi-content-degraded'], undefined);
      check('all banners off still has an ETag', Boolean(empty.headers.etag));

      store.listHomeBanners = async () => { throw new Error('simulated database failure'); };
      const degraded = await feed();
      check('internal error -> 200 with an empty list', degraded.status === 200 && degraded.json.banners.length === 0, degraded.raw.slice(0, 200));
      assertEqual('internal error -> X-Plyndi-Content-Degraded: 1', degraded.headers['x-plyndi-content-degraded'], '1');
      assertEqual('internal error -> Cache-Control: no-store', degraded.headers['cache-control'], 'no-store');
      assertEqual('internal error -> no ETag (not even Express\'s own)', degraded.headers.etag, undefined);
      check('internal error still reports the carousel settings', degraded.json.intervalSeconds === 4 && degraded.json.aspectRatio === 3, degraded.raw);
    } finally {
      store.listHomeBanners = realListHomeBanners;
    }

    const explore = await request(port, 'GET', '/v1/content/explore', clientHeaders());
    check('the Explore feed still serves its seeded cards', explore.status === 200 && explore.json.cards.length >= 3, explore.raw.slice(0, 200));
  } finally {
    await removeAll();
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
