// shopping_suggestions v2 (Sep 2026) — context schema + prompt template contract.
// Run from backend-live:  node --test test/shoppingSuggestionsContext.test.js
// No server, provider or database: these exercise the capability file itself through the same
// validator and renderer POST /v1/ai/run uses, so a schema/template edit that would start
// rejecting shipped clients (400 invalid_context) or leave a placeholder unresolved fails here.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { validate } = require('../src/lib/jsonSchemaLite');
const { renderPromptTemplate } = require('../src/lib/renderPromptTemplate');

const capability = require(path.join('..', 'capabilities', 'shopping_suggestions.json'));
const schema = capability.contextSchema;

// Exactly what a pre-v2 app build sends (AIContextBuilder.shoppingSuggestionsContext before Sep 2026).
const v1Context = {
  toBuyTotal: 12.5,
  currencySymbol: '$',
  toBuyItems: [{ name: 'Milk', category: 'Groceries', cost: 4 }],
};

// A full v2 context, as ShoppingContextSnapshot.contextFields builds it.
function v2Context(overrides = {}) {
  return {
    toBuyTotal: 180,
    currencySymbol: 'NT$',
    currencyCode: 'TWD',
    regionCode: 'TW',
    responseLanguage: 'Traditional Chinese',
    listName: 'Groceries',
    occasion: 'weekly groceries',
    usesOtherData: true,
    todayISO: '2026-09-27',
    toBuyItems: [{ name: '鹽', category: 'Groceries', cost: 30, userPriced: true }],
    excludedNames: ['Rice'],
    cadence: [{ name: 'Oat milk', category: 'Groceries', timesBought: 4, lastBought: '2026-09-15', daysSinceLast: 12, usualIntervalDays: 10, typicalPrice: 95 }],
    trips: [{ destination: 'Osaka', daysUntil: 9, nights: 4, needToBuy: ['Sunscreen', 'Travel adapter', 'SIM card'] }],
    events: [{ title: "Mom's birthday", daysUntil: 5 }],
    tasks: [{ title: 'Host dinner for Ken', dueInDays: 3 }],
    money: { monthlyBudgetRemaining: 3200, shoppingSpendThisMonth: [{ category: 'Groceries', amount: 2400 }] },
    ...overrides,
  };
}

const repeat = (n, make) => Array.from({ length: n }, (_, i) => make(i));

test('capability is version 2 and requires a declared cost currency', () => {
  assert.equal(capability.version, 2);
  assert.ok(capability.jsonSchema.required.includes('costCurrencyCode'));
  assert.ok(capability.jsonSchema.required.includes('needsOccasion'));
  const item = capability.jsonSchema.properties.suggestedItems.items;
  for (const field of ['unitHint', 'priceConfidence', 'sourceKind', 'sourceRef']) {
    assert.ok(item.required.includes(field), `${field} should be required on each suggestion`);
  }
  assert.deepEqual(item.properties.priceConfidence.enum, ['typical', 'rough']);
  assert.deepEqual(item.properties.sourceKind.enum, ['list', 'cadence', 'trip', 'event', 'task', 'occasion']);
});

test('a v1-shaped context is still accepted (every v2 field is optional)', () => {
  assert.equal(validate(schema, v1Context), null);
  assert.equal(validate(schema, { toBuyTotal: 0, currencySymbol: '$' }), null);
});

test('a full v2 context is accepted', () => {
  assert.equal(validate(schema, v2Context()), null);
});

test('the v1 required fields are still required', () => {
  assert.match(validate(schema, { currencySymbol: '$' }), /toBuyTotal is required/);
  assert.match(validate(schema, { toBuyTotal: 1 }), /currencySymbol is required/);
});

test('caps are enforced on every new array', () => {
  const cases = [
    ['cadence', 31, (i) => ({ name: `item ${i}`, timesBought: 1, daysSinceLast: 3 })],
    ['trips', 4, (i) => ({ destination: `city ${i}`, daysUntil: i })],
    ['events', 11, (i) => ({ title: `event ${i}`, daysUntil: i })],
    ['tasks', 16, (i) => ({ title: `task ${i}`, dueInDays: i })],
    ['excludedNames', 61, (i) => `name ${i}`],
  ];
  for (const [field, count, make] of cases) {
    const atCap = validate(schema, v2Context({ [field]: repeat(count - 1, make) }));
    assert.equal(atCap, null, `${field} at its cap should pass`);
    const overCap = validate(schema, v2Context({ [field]: repeat(count, make) }));
    assert.match(overCap, new RegExp(`${field} must have at most ${count - 1} items`));
  }
  const tooMuchToBuy = v2Context({ trips: [{ destination: 'Osaka', daysUntil: 9, needToBuy: repeat(16, (i) => `thing ${i}`) }] });
  assert.match(validate(schema, tooMuchToBuy), /needToBuy must have at most 15 items/);
  const tooManySpendRows = v2Context({ money: { shoppingSpendThisMonth: repeat(13, (i) => ({ category: `c${i}`, amount: i })) } });
  assert.match(validate(schema, tooManySpendRows), /shoppingSpendThisMonth must have at most 12 items/);
});

test('field types and lengths are checked', () => {
  assert.match(validate(schema, v2Context({ cadence: [{ name: 'x', timesBought: 'four', daysSinceLast: 1 }] })), /timesBought must be an integer/);
  assert.match(validate(schema, v2Context({ trips: [{ destination: 'Osaka' }] })), /daysUntil is required/);
  assert.match(validate(schema, v2Context({ occasion: 'x'.repeat(121) })), /occasion must be at most 120 characters/);
  assert.match(validate(schema, v2Context({ usesOtherData: 'yes' })), /usesOtherData must be a boolean/);
});

test('the prompt renders with no unresolved placeholders, for v1 and v2 contexts', () => {
  for (const context of [v1Context, v2Context(), v2Context({ usesOtherData: false, cadence: undefined, trips: undefined })]) {
    const rendered = renderPromptTemplate(capability.userPromptTemplate, { ...context, locale: 'zh-Hant' });
    assert.ok(!/\{\{\s*context\./.test(rendered), 'unresolved placeholder left in the prompt');
  }
  const rendered = renderPromptTemplate(capability.userPromptTemplate, { ...v2Context(), locale: 'zh-Hant' });
  assert.ok(rendered.includes('"TWD"') && rendered.includes('"TW"'));
  assert.ok(rendered.includes('"Osaka"') && rendered.includes("Mom's birthday"));
  assert.ok(rendered.includes('"Traditional Chinese"'));
});

test('every placeholder the template uses is declared in contextSchema (or is locale)', () => {
  const used = new Set([...capability.userPromptTemplate.matchAll(/\{\{\s*context\.([a-zA-Z0-9_]+)/g)].map((m) => m[1]));
  for (const key of used) {
    assert.ok(key === 'locale' || key in schema.properties, `{{context.${key}}} is not declared in contextSchema`);
  }
});

test('the prompt forbids default staples and requires a real number in the budget tip', () => {
  const template = capability.userPromptTemplate;
  assert.ok(template.includes('NO GENERIC STAPLES'));
  assert.ok(template.includes('needsOccasion'));
  assert.ok(!template.includes('2-3 common staples'), 'the v1 "suggest staples on an empty list" rule must be gone');
  assert.ok(template.includes('budgetTip must quote at least one real number'));
  assert.ok(template.includes('Never mentally convert a price from another country'));
});
