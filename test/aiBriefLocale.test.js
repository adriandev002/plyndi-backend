// Daily Brief locale-aware cache — unit tests for the staleness predicate.
// Run from backend-live:  node --test test/aiBriefLocale.test.js
// These tests need no server, provider, or database: they exercise the pure predicate
// the GET /v1/ai/brief handler uses to decide cache-hit vs regenerate.
const test = require('node:test');
const assert = require('node:assert/strict');

const { isBriefLocaleStale } = require('../src/routes/aiBrief');

const brief = (digestLocale, briefLocale) => ({
  subject: 'user-a',
  localDate: '2026-09-27',
  digest: digestLocale === undefined ? {} : { locale: digestLocale },
  briefText: 'cached brief text',
  briefLocale,
  provider: 'test-provider',
  model: 'test-model',
  createdAtMs: Date.now(),
});

test('same locale retains the cached brief (no regeneration)', () => {
  assert.equal(isBriefLocaleStale(brief('my', 'my')), false);
  assert.equal(isBriefLocaleStale(brief('en', 'en')), false);
  assert.equal(isBriefLocaleStale(brief('zh-Hant', 'zh-Hant')), false);
});

test('changed locale invalidates the old-language brief', () => {
  assert.equal(isBriefLocaleStale(brief('my', 'en')), true);
  assert.equal(isBriefLocaleStale(brief('en', 'my')), true);
  assert.equal(isBriefLocaleStale(brief('th', 'zh-Hans')), true);
});

test('legacy rows without a stamped brief locale regenerate once, then stay cached', () => {
  // briefLocale null (pre-migration row) + digest locale set → stale → one regeneration,
  // which stamps brief_locale; the next GET with the same digest locale is a cache hit.
  assert.equal(isBriefLocaleStale(brief('my', null)), true);
  assert.equal(isBriefLocaleStale(brief('my', undefined)), true);
  assert.equal(isBriefLocaleStale(brief('my', 'my')), false);
});

test('missing digest locale or missing brief never proves staleness', () => {
  assert.equal(isBriefLocaleStale(brief(undefined, 'en')), false); // older client, no locale
  assert.equal(isBriefLocaleStale(brief(null, 'en')), false);
  assert.equal(isBriefLocaleStale(brief(null, null)), false);
  assert.equal(isBriefLocaleStale(null), false);
  assert.equal(isBriefLocaleStale({ briefText: null, digest: { locale: 'my' } }), false);
});
