// daily_brief v3 (Sep 2026) — one-sentence briefs; the digest may carry shopping counts; older digests stay valid.
// Run from backend-live:  node --test test/dailyBriefShopping.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { validate } = require('../src/lib/jsonSchemaLite');
const { renderPromptTemplate } = require('../src/lib/renderPromptTemplate');

const capability = require(path.join('..', 'capabilities', 'daily_brief.json'));

test('a digest without shopping (older app builds) is still valid', () => {
  assert.equal(validate(capability.contextSchema, { locale: 'en', trip: { name: 'Osaka', daysUntil: 9 } }), null);
});

test('a digest with shopping counts is valid, and they reach the prompt', () => {
  const digest = { locale: 'ja', shopping: { toBuyCount: 6, dueSoonCount: 2 } };
  assert.equal(validate(capability.contextSchema, digest), null);
  const rendered = renderPromptTemplate(capability.userPromptTemplate, digest);
  assert.ok(rendered.includes('to buy, count (null if nothing is left to buy): 6'));
  assert.ok(rendered.includes('next 7 days, count (null if unknown; 0 means none are urgent): 2'));
  assert.ok(!/\{\{\s*context\./.test(rendered));
});

test('shopping counts must be integers', () => {
  assert.match(validate(capability.contextSchema, { shopping: { toBuyCount: 'six' } }), /toBuyCount must be an integer/);
});

test('absent shopping renders as null and the prompt says to skip it', () => {
  const rendered = renderPromptTemplate(capability.userPromptTemplate, { locale: 'en' });
  assert.ok(rendered.includes('nothing is left to buy): null'));
  assert.ok(capability.systemPrompt.includes('omit that topic entirely'));
});
