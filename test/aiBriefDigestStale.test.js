// Daily Brief digest-change invalidation — unit tests for the staleness predicate.
// Run from backend-live:  node --test test/aiBriefDigestStale.test.js
// These tests need no server, provider, or database: they exercise the pure predicate
// the POST /v1/ai/brief/digest handler uses to decide whether a same-day digest repost
// invalidates an already-generated brief.
const test = require('node:test');
const assert = require('node:assert/strict');

const { isBriefDigestStale } = require('../src/routes/aiBrief');

const row = (digest, briefText = 'cached brief text') => ({
  subject: 'user-a',
  localDate: '2026-09-28',
  digest,
  briefText,
  briefLocale: 'en',
  provider: 'test-provider',
  model: 'test-model',
  createdAtMs: Date.now(),
});

const hanoi = { locale: 'en', trip: { name: 'Hanoi', daysUntil: 29 } };
const osaka = { locale: 'en', trip: { name: 'Osaka', daysUntil: 12 } };

test('no existing row, or no generated brief yet, never invalidates', () => {
  assert.equal(isBriefDigestStale(null, hanoi), false);
  assert.equal(isBriefDigestStale(undefined, hanoi), false);
  assert.equal(isBriefDigestStale(row(hanoi, null), osaka), false);
  const noBriefKey = row(hanoi);
  delete noBriefKey.briefText;
  assert.equal(isBriefDigestStale(noBriefKey, osaka), false);
});

test('identical digest never invalidates — even with shuffled key order', () => {
  assert.equal(isBriefDigestStale(row(hanoi), { ...hanoi }), false);
  assert.equal(
    isBriefDigestStale(row(hanoi), { trip: { daysUntil: 29, name: 'Hanoi' }, locale: 'en' }),
    false
  );
});

test('empty new digest never invalidates (the app never POSTs one)', () => {
  assert.equal(isBriefDigestStale(row(hanoi), {}), false);
  assert.equal(isBriefDigestStale(row(hanoi), null), false);
  assert.equal(isBriefDigestStale(row(hanoi), undefined), false);
});

test('removed trip invalidates the stale brief', () => {
  assert.equal(isBriefDigestStale(row(hanoi), { locale: 'en' }), true);
});

test('changed trip invalidates the stale brief', () => {
  assert.equal(isBriefDigestStale(row(hanoi), osaka), true);
});

test('new tasks / changed counts invalidate the stale brief', () => {
  const before = { locale: 'en', tasks: { dueTodayCount: 0, overdueCount: 0 } };
  const after = { locale: 'en', tasks: { dueTodayCount: 0, overdueCount: 3 } };
  assert.equal(isBriefDigestStale(row(before), after), true);
  assert.equal(isBriefDigestStale(row(after), before), true);
});

test('locale-only change invalidates (unified with the GET-side locale check)', () => {
  assert.equal(isBriefDigestStale(row(hanoi), { ...hanoi, locale: 'my' }), true);
});

test('empty stored digest plus a real new digest invalidates', () => {
  assert.equal(isBriefDigestStale(row({}, 'cached'), hanoi), true);
  assert.equal(isBriefDigestStale(row(null, 'cached'), hanoi), true);
});
