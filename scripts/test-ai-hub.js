// Plain-Node smoke test for GET /v1/ai/hub (Phase 2-A) — same no-framework style as
// scripts/test-config.js and scripts/test-ai-run.js: `node scripts/test-ai-hub.js`.
//
// Covers:
//   1. Every shipped card's copyKeys resolve to a real CopyKey case in the iOS app's
//      AppStore.swift — the single most likely silent failure (a key that doesn't exist renders
//      as nothing), checkable here by grepping the enum directly. Skipped (not failed) if the iOS
//      checkout can't be found on this machine — see APPSTORE_SWIFT_CANDIDATES below.
//   2. receipt_scan and form_coach are card type "link", never "inline"/"input" (providerGateway
//      is text-only — Plyndi-AI-Hub-Design.md §10).
//   3. A live server: enabled:false, a remote-config.json feature flip, and the minAppVersion gate
//      each omit exactly the right card, with no restart — all via SIGHUP-equivalent in-process
//      reloads, same technique scripts/test-ai-run.js uses for capabilityRegistry.
//   4. A malformed card is skipped; the other eight still serve; no 500.
//   5. A missing/corrupt hub.json still serves a valid, non-empty catalog (logged loudly).
//   6. ETag / If-None-Match -> 304.
//   7. Every type is one of the four fixed ones; every sheetId/destination is in the documented
//      allowed set.
//   8. Section/card ordering is stable across repeated calls.
//   9. hub.json's staticCards mechanism (non-capability, pure-link cards) actually merges in.
//
// All on-disk files this script mutates are restored, even on failure.

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const CAPABILITIES_DIR = path.join(ROOT, 'capabilities');
const HUB_CONFIG_PATH = path.join(ROOT, 'src', 'config', 'hub.json');
const REMOTE_CONFIG_PATH = path.join(ROOT, 'src', 'config', 'remote-config.json');

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

// The card contract's frozen allowed sets, declared independently here (not imported from
// src/routes/aiHub.js) so this test actually catches a drift between the route's internal list
// and what's documented in README.md, instead of trivially agreeing with itself.
const CARD_TYPES = ['inline', 'sheet', 'link', 'input'];
const ALLOWED_SHEET_IDS = ['dailyPlan', 'shoppingAssistant'];
const ALLOWED_DESTINATIONS = ['quickAdd', 'travelPlanner', 'fitness'];
const IMAGE_ONLY_CAPABILITY_IDS = ['receipt_scan', 'form_coach'];

// ---------------------------------------------------------------------------
// 1. copyKeys resolve to real CopyKey cases in the iOS app's AppStore.swift.
// ---------------------------------------------------------------------------
console.log('\n=== copyKeys resolve to real CopyKey cases in AppStore.swift ===');

const APPSTORE_SWIFT_CANDIDATES = [
  process.env.PLYNDI_IOS_APPSTORE_SWIFT,
  path.join(os.homedir(), 'Manus', 'Plyndi', 'Plyndi', 'AppStore.swift'),
  path.join(ROOT, '..', 'Plyndi', 'Plyndi', 'AppStore.swift'),
  path.join(ROOT, '..', '..', 'Plyndi', 'Plyndi', 'AppStore.swift'),
].filter(Boolean);

function findAppStoreSwift() {
  for (const candidate of APPSTORE_SWIFT_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function loadCopyKeyNames(swiftPath) {
  const src = fs.readFileSync(swiftPath, 'utf8');
  const names = new Set();
  // `enum CopyKey: String, CaseIterable { case foo ... , case foo = "Bar" ... }` — cases can be
  // comma-separated on one line or one per line; both forms use `case <name>` as the case's start.
  const caseRe = /\bcase\s+([A-Za-z_][A-Za-z0-9_]*)/g;
  let match;
  while ((match = caseRe.exec(src)) !== null) {
    names.add(match[1]);
  }
  return names;
}

function allCapabilityCards() {
  return fs.readdirSync(CAPABILITIES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const parsed = JSON.parse(fs.readFileSync(path.join(CAPABILITIES_DIR, f), 'utf8'));
      return { id: parsed.id, card: parsed.card };
    })
    .filter((c) => c.card);
}

const appStoreSwiftPath = findAppStoreSwift();
if (!appStoreSwiftPath) {
  console.log(`  SKIP  AppStore.swift not found (looked in: ${APPSTORE_SWIFT_CANDIDATES.join(', ')}) — set PLYNDI_IOS_APPSTORE_SWIFT to check this on a machine without the iOS checkout alongside the backend.`);
} else {
  const copyKeyNames = loadCopyKeyNames(appStoreSwiftPath);
  console.log(`  found AppStore.swift at ${appStoreSwiftPath} (${copyKeyNames.size} CopyKey cases)`);
  const usedKeys = [];
  for (const { id, card } of allCapabilityCards()) {
    for (const [field, keyName] of Object.entries(card.copyKeys || {})) {
      usedKeys.push({ id, field, keyName });
    }
  }
  for (const { id, field, keyName } of usedKeys) {
    check(`${id}.copyKeys.${field} = "${keyName}" exists as a CopyKey case`, copyKeyNames.has(keyName));
  }
  console.log(`  ${usedKeys.length} copyKey reference(s) checked across ${allCapabilityCards().length} card(s).`);
}

// ---------------------------------------------------------------------------
// 2. receipt_scan and form_coach are type "link" — never inline/input.
// ---------------------------------------------------------------------------
console.log('\n=== image-only capabilities are never inline/input ===');
// providerGateway.generate() is TEXT-ONLY (Plyndi-AI-Hub-Design.md §10 known gap). receipt_scan
// and form_coach both require an image in their contextSchema; an inline/input hub card for
// either would silently send that image into a text-only call, which validates the field and then
// ignores it — a confident wrong answer with no error anywhere. They must only ever be "link".
for (const id of IMAGE_ONLY_CAPABILITY_IDS) {
  const parsed = JSON.parse(fs.readFileSync(path.join(CAPABILITIES_DIR, `${id}.json`), 'utf8'));
  assertEqual(`${id}.card.type is "link" (never inline/input — needs a photo, gateway is text-only)`, parsed.card.type, 'link');
}

// ---------------------------------------------------------------------------
// Server + live-request plumbing
// ---------------------------------------------------------------------------
const CLIENT_KEY = 'test-shared-key';
process.env.CLIENT_SHARED_KEY = CLIENT_KEY;

const app = require('../src/server');
const registry = require('../src/lib/capabilityRegistry');
const aiHub = require('../src/routes/aiHub');

function request(port, method, reqPath, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ port, path: reqPath, method, headers }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch (_e) { /* not JSON, e.g. empty 304 */ }
        resolve({ status: res.statusCode, headers: res.headers, raw, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}
function get(port, reqPath, headers) {
  return request(port, 'GET', reqPath, headers);
}
const authHeaders = (extra) => Object.assign({ 'X-Plyndi-Client-Key': CLIENT_KEY, 'X-Plyndi-Platform': 'ios' }, extra);

function cardIds(sections) {
  const ids = [];
  for (const section of sections) for (const card of section.cards) ids.push(card.id);
  return ids;
}
function findCard(sections, id) {
  for (const section of sections) {
    const found = section.cards.find((c) => c.id === id);
    if (found) return { section, card: found };
  }
  return null;
}

async function main() {
  const port = await new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server.address().port));
  });

  const originalHubConfig = fs.readFileSync(HUB_CONFIG_PATH, 'utf8');
  const originalRemoteConfig = fs.readFileSync(REMOTE_CONFIG_PATH, 'utf8');
  const originalCapabilityFiles = new Map();
  for (const file of fs.readdirSync(CAPABILITIES_DIR)) {
    if (file.endsWith('.json')) originalCapabilityFiles.set(file, fs.readFileSync(path.join(CAPABILITIES_DIR, file), 'utf8'));
  }

  function restoreEverything() {
    fs.writeFileSync(HUB_CONFIG_PATH, originalHubConfig);
    fs.writeFileSync(REMOTE_CONFIG_PATH, originalRemoteConfig);
    for (const [file, content] of originalCapabilityFiles) fs.writeFileSync(path.join(CAPABILITIES_DIR, file), content);
    registry.loadCapabilities();
    aiHub.loadHubConfig();
    aiHub.loadRemoteFeatures();
  }

  try {
    // -------------------------------------------------------------------
    // 3. Baseline: full catalog, all nine cards, correct shapes.
    // -------------------------------------------------------------------
    console.log('\n=== GET /v1/ai/hub — baseline (X-Plyndi-App-Version: 1.0) ===');
    const baseline = await get(port, '/v1/ai/hub', authHeaders({ 'X-Plyndi-App-Version': '1.0' }));
    assertEqual('status 200', baseline.status, 200);
    for (const key of ['hubVersion', 'ttlSeconds', 'sections', 'serverTime']) {
      check(`response has key "${key}"`, baseline.json && Object.prototype.hasOwnProperty.call(baseline.json, key));
    }
    const baselineIds = cardIds(baseline.json.sections).sort();
    // Phase 5-A added `ask_router` to the registry with NO `card` block at all (it's invoked from
    // the hub's search bar, not rendered as its own card — see capabilityRegistry.js's header
    // comment) — the exact same "no card" shape daily_brief already has, except daily_brief is
    // never loaded into this registry at all, so it never reached this comparison. `ask_router`
    // genuinely is loaded here, so `registry.all()` is no longer "every capability has a card";
    // filter to the ones that declare one before comparing to what the hub actually rendered.
    const allCapIds = registry.all().filter((c) => c.card).map((c) => c.id).sort();
    assertEqual('every enabled capability with a valid card is present at app version 1.0', JSON.stringify(baselineIds), JSON.stringify(allCapIds));
    check('ask_router is loaded but never appears as a hub card', !baselineIds.includes('ask_router') && registry.all().some((c) => c.id === 'ask_router' && !c.card));

    console.log('\n=== every card type is one of the four fixed ones; sheetId/destination in the allowed set ===');
    for (const section of baseline.json.sections) {
      for (const card of section.cards) {
        check(`${card.id}.type "${card.type}" is one of ${CARD_TYPES.join('/')}`, CARD_TYPES.includes(card.type));
        if (card.sheetId !== null) check(`${card.id}.sheetId "${card.sheetId}" is in the allowed set`, ALLOWED_SHEET_IDS.includes(card.sheetId));
        if (card.destination !== null) check(`${card.id}.destination "${card.destination}" is in the allowed set`, ALLOWED_DESTINATIONS.includes(card.destination));
        if (card.type === 'sheet') check(`${card.id} (type sheet) has a non-null sheetId`, card.sheetId !== null);
        if (card.type === 'link') check(`${card.id} (type link) has a non-null destination`, card.destination !== null);
      }
    }

    console.log('\n=== ordering is stable across repeated calls ===');
    const repeat = await get(port, '/v1/ai/hub', authHeaders({ 'X-Plyndi-App-Version': '1.0' }));
    assertEqual('section order is identical across two calls', JSON.stringify(baseline.json.sections.map((s) => s.id)), JSON.stringify(repeat.json.sections.map((s) => s.id)));
    assertEqual('card order within sections is identical across two calls', JSON.stringify(cardIds(baseline.json.sections)), JSON.stringify(cardIds(repeat.json.sections)));

    // -------------------------------------------------------------------
    // 4. ETag / If-None-Match -> 304.
    // -------------------------------------------------------------------
    console.log('\n=== ETag / If-None-Match ===');
    const etag = baseline.headers.etag;
    check('ETag header present', Boolean(etag));
    assertEqual('Cache-Control is no-cache', baseline.headers['cache-control'], 'no-cache');
    const revalidated = await get(port, '/v1/ai/hub', authHeaders({ 'X-Plyndi-App-Version': '1.0', 'If-None-Match': etag }));
    assertEqual('If-None-Match with matching ETag -> 304', revalidated.status, 304);

    // -------------------------------------------------------------------
    // 5. minAppVersion gate (readiness.json minAppVersion is "1.0").
    // -------------------------------------------------------------------
    console.log('\n=== minAppVersion gate ===');
    const belowMin = await get(port, '/v1/ai/hub', authHeaders({ 'X-Plyndi-App-Version': '0.9' }));
    check('caller version 0.9 < minAppVersion 1.0 -> readiness card omitted', findCard(belowMin.json.sections, 'readiness') === null);
    const exactMin = await get(port, '/v1/ai/hub', authHeaders({ 'X-Plyndi-App-Version': '1.0' }));
    check('caller version "1.0" == minAppVersion "1.0" -> readiness card present', findCard(exactMin.json.sections, 'readiness') !== null);
    const noHeader = await get(port, '/v1/ai/hub', authHeaders());
    check('no X-Plyndi-App-Version header -> readiness card still present (fail open)', findCard(noHeader.json.sections, 'readiness') !== null);

    // -------------------------------------------------------------------
    // 6. enabled:false omits exactly that card.
    // -------------------------------------------------------------------
    console.log('\n=== capability enabled:false omits its card ===');
    const readinessPath = path.join(CAPABILITIES_DIR, 'readiness.json');
    const disabledReadiness = JSON.parse(originalCapabilityFiles.get('readiness.json'));
    disabledReadiness.enabled = false;
    fs.writeFileSync(readinessPath, JSON.stringify(disabledReadiness, null, 2));
    registry.loadCapabilities();
    const afterDisable = await get(port, '/v1/ai/hub', authHeaders({ 'X-Plyndi-App-Version': '1.0' }));
    check('readiness card omitted once enabled:false, no restart', findCard(afterDisable.json.sections, 'readiness') === null);
    check('the other eight cards are unaffected', cardIds(afterDisable.json.sections).length === allCapIds.length - 1);
    fs.writeFileSync(readinessPath, originalCapabilityFiles.get('readiness.json'));
    registry.loadCapabilities();

    // -------------------------------------------------------------------
    // 7. remote-config.json feature flip omits exactly that card, via SIGHUP-equivalent reload.
    // -------------------------------------------------------------------
    console.log('\n=== remote-config.json feature flip omits its card (SIGHUP-equivalent reload) ===');
    const remoteConfigParsed = JSON.parse(originalRemoteConfig);
    remoteConfigParsed.features.workout_plan = false;
    fs.writeFileSync(REMOTE_CONFIG_PATH, JSON.stringify(remoteConfigParsed, null, 2));
    aiHub.loadRemoteFeatures();
    const afterFeatureFlip = await get(port, '/v1/ai/hub', authHeaders({ 'X-Plyndi-App-Version': '1.0' }));
    check('workout_plan card omitted once its feature id is false, no restart', findCard(afterFeatureFlip.json.sections, 'workout_plan') === null);
    check('the other eight cards are unaffected', cardIds(afterFeatureFlip.json.sections).length === allCapIds.length - 1);
    fs.writeFileSync(REMOTE_CONFIG_PATH, originalRemoteConfig);
    aiHub.loadRemoteFeatures();
    const afterFeatureRestore = await get(port, '/v1/ai/hub', authHeaders({ 'X-Plyndi-App-Version': '1.0' }));
    check('workout_plan card back once the feature flag is restored', findCard(afterFeatureRestore.json.sections, 'workout_plan') !== null);

    // -------------------------------------------------------------------
    // 8. A malformed card is skipped; the other eight still serve; never a 500.
    // -------------------------------------------------------------------
    console.log('\n=== malformed card is skipped, the rest still serve ===');
    const budgetPath = path.join(CAPABILITIES_DIR, 'budget_insights.json');
    const malformedBudget = JSON.parse(originalCapabilityFiles.get('budget_insights.json'));
    malformedBudget.card.type = 'teaser'; // not one of the four fixed types
    fs.writeFileSync(budgetPath, JSON.stringify(malformedBudget, null, 2));
    registry.loadCapabilities();
    let loggedSkip = '';
    const originalConsoleError = console.error;
    console.error = (...args) => { loggedSkip += args.join(' ') + '\n'; originalConsoleError(...args); };
    const afterMalformed = await get(port, '/v1/ai/hub', authHeaders({ 'X-Plyndi-App-Version': '1.0' }));
    console.error = originalConsoleError;
    assertEqual('malformed card -> still 200, never a 500', afterMalformed.status, 200);
    check('budget_insights card omitted (malformed type)', findCard(afterMalformed.json.sections, 'budget_insights') === null);
    check('the other eight cards still served', cardIds(afterMalformed.json.sections).length === allCapIds.length - 1);
    check('a SKIPPING log line was printed for the malformed card', loggedSkip.includes('SKIPPING card for capability "budget_insights"'), loggedSkip);
    fs.writeFileSync(budgetPath, originalCapabilityFiles.get('budget_insights.json'));
    registry.loadCapabilities();

    // -------------------------------------------------------------------
    // 9. Missing/corrupt hub.json -> still a valid, non-empty catalog, logged loudly.
    // -------------------------------------------------------------------
    console.log('\n=== missing/corrupt hub.json -> still a valid catalog ===');
    fs.writeFileSync(HUB_CONFIG_PATH, '{ this is not valid json');
    let loggedFallback = '';
    console.error = (...args) => { loggedFallback += args.join(' ') + '\n'; originalConsoleError(...args); };
    aiHub.loadHubConfig();
    console.error = originalConsoleError;
    check('aiHub reports it is serving the fallback catalog', aiHub.isFallback() === true);
    check('failure logged loudly', loggedFallback.includes('[ai/hub] FAILED to load hub.json'), loggedFallback);
    const afterCorruptHub = await get(port, '/v1/ai/hub', authHeaders({ 'X-Plyndi-App-Version': '1.0' }));
    assertEqual('corrupt hub.json -> still 200, never a 500', afterCorruptHub.status, 200);
    check('corrupt hub.json -> catalog is non-empty (derived from the capability cards alone)', cardIds(afterCorruptHub.json.sections).length > 0);
    check('corrupt hub.json -> every card still lands in some section', cardIds(afterCorruptHub.json.sections).length === allCapIds.length);
    fs.writeFileSync(HUB_CONFIG_PATH, originalHubConfig);
    aiHub.loadHubConfig();
    check('aiHub back off the fallback once hub.json is restored', aiHub.isFallback() === false);

    // -------------------------------------------------------------------
    // 10. staticCards mechanism — a pure-link card with no backing capability.
    // -------------------------------------------------------------------
    console.log('\n=== staticCards: a pure-link card with no AI capability behind it ===');
    const hubWithStatic = JSON.parse(originalHubConfig);
    hubWithStatic.staticCards = [{
      id: 'refer_a_friend',
      type: 'link',
      section: 'planning',
      order: 999,
      icon: 'gift',
      copyKeys: {},
      fallbackText: { title: { en: 'Refer a Friend' } },
      sheetId: null,
      destination: 'fitness', // reusing an already-allowed destination for this smoke test
    }];
    fs.writeFileSync(HUB_CONFIG_PATH, JSON.stringify(hubWithStatic, null, 2));
    aiHub.loadHubConfig();
    const afterStaticCard = await get(port, '/v1/ai/hub', authHeaders({ 'X-Plyndi-App-Version': '1.0' }));
    const staticFound = findCard(afterStaticCard.json.sections, 'refer_a_friend');
    check('static card appears in the catalog', staticFound !== null);
    check('static card lands in its declared section', staticFound && staticFound.section.id === 'planning');
    check('static card is present even though no capability/kill-switch backs it', staticFound !== null);
    fs.writeFileSync(HUB_CONFIG_PATH, originalHubConfig);
    aiHub.loadHubConfig();

    // -------------------------------------------------------------------
    // 11. Side effect check: /v1/ai/run and /v1/config are untouched by any of the above.
    // -------------------------------------------------------------------
    console.log('\n=== side effects: /v1/config still serves normally ===');
    const configCheck = await get(port, '/v1/config', authHeaders({ 'X-Plyndi-App-Version': '1.0' }));
    assertEqual('/v1/config -> 200 after all aiHub reloads above', configCheck.status, 200);
  } finally {
    restoreEverything();
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  process.exitCode = failures === 0 ? 0 : 1;
  process.exit(process.exitCode); // the in-process server keeps the event loop alive otherwise
}

main().catch((err) => {
  console.error('Test script crashed:', err);
  process.exitCode = 1;
  process.exit(1);
});
