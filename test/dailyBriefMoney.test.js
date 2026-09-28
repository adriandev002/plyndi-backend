// daily_brief v4 (Sep 2026, Connected Life) — the digest may carry a `money` topic: bills, debts and
// subscriptions due or overdue, the next one due, and money owed back to the user. Older app builds
// send no `money` key at all, and those digests must stay valid.
// Run from backend-live:  node --test test/dailyBriefMoney.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { validate } = require('../src/lib/jsonSchemaLite');
const { renderPromptTemplate } = require('../src/lib/renderPromptTemplate');

const capability = require(path.join('..', 'capabilities', 'daily_brief.json'));

test('a digest without money (older app builds) is still valid', () => {
  assert.equal(validate(capability.contextSchema, { locale: 'en', shopping: { toBuyCount: 2, dueSoonCount: 0 } }), null);
  assert.equal(validate(capability.contextSchema, { locale: 'en', money: null }), null);
});

// Strings reach the prompt JSON-quoted, numbers bare (renderPromptTemplate).
test('a digest with a money topic is valid, and every field reaches the prompt', () => {
  const digest = {
    locale: 'zh-Hant',
    money: {
      dueTodayCount: 2,
      dueTodayTotal: 1590,
      currencySymbol: 'NT$',
      overdueCount: 1,
      nextItemName: 'Electricity',
      nextItemDaysUntil: 1,
      receivableDueCount: 1,
    },
  };
  assert.equal(validate(capability.contextSchema, digest), null);
  const rendered = renderPromptTemplate(capability.userPromptTemplate, digest);
  assert.ok(rendered.includes('due today, count (null if none): 2'));
  assert.ok(rendered.includes('in the money currency (null if none): 1590'));
  assert.ok(rendered.includes('Money currency symbol (null if unknown): "NT$"'));
  assert.ok(rendered.includes('Overdue bills, debts and subscriptions, count (null if none): 1'));
  assert.ok(rendered.includes('due within 7 days (null if none): "Electricity"'));
  assert.ok(rendered.includes('0 meaning today (null if none): 1'));
  assert.ok(rendered.includes('due back today or overdue, count (null if none): 1'));
  assert.ok(!/\{\{\s*context\./.test(rendered));
});

test('a partial money topic (only the next bill) is valid; the rest renders as null', () => {
  const digest = { locale: 'en', money: { nextItemName: 'Rent', nextItemDaysUntil: 3, currencySymbol: '$' } };
  assert.equal(validate(capability.contextSchema, digest), null);
  const rendered = renderPromptTemplate(capability.userPromptTemplate, digest);
  assert.ok(rendered.includes('due today, count (null if none): null'));
  assert.ok(rendered.includes('due within 7 days (null if none): "Rent"'));
});

test('money counts must be integers and the total a number', () => {
  assert.match(validate(capability.contextSchema, { money: { overdueCount: 'two' } }), /overdueCount must be an integer/);
  assert.notEqual(validate(capability.contextSchema, { money: { dueTodayTotal: 'lots' } }), null);
});

test('absent money renders as null and the prompt still says to skip empty topics and never invent', () => {
  const rendered = renderPromptTemplate(capability.userPromptTemplate, { locale: 'en' });
  assert.ok(rendered.includes('Overdue bills, debts and subscriptions, count (null if none): null'));
  assert.ok(capability.systemPrompt.includes('omit that topic entirely'));
  assert.ok(capability.systemPrompt.includes('Never invent a number'));
});
