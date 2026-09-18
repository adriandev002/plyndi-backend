// ============================================================================
// GET /v1/ai/hub — Phase 2-A server-driven AI Hub catalog (Plyndi-AI-Hub-Design.md §3.3, §4.2).
// ----------------------------------------------------------------------------
// The app's AI Hub screen (AIHubView.swift) is today a hardcoded Swift list. This route makes the
// SERVER describe that screen instead: sections, cards, which capability backs each card, and the
// localized copy to show. A new card, a reorder, or reworded copy becomes a backend deploy instead
// of an App Store release.
//
// Card contract (frozen once Phase 2-B ships a renderer for it — see README.md):
//   type         "inline" | "sheet" | "link" | "input"   — the only four the app will ever render
//   section      groups cards under a src/config/hub.json section id
//   icon         SF Symbol name, a display hint only
//   copyKeys     { title?, subtitle? } → real CopyKey names the app resolves locally
//   fallbackText { title?, subtitle? } → { locale: text }, only for copy the app has never shipped
//   sheetId      opaque id into the app's own sheet registry (type "sheet" only)
//   destination  opaque id into the app's own navigation (type "link" only)
//
// A card is omitted from the response — never causes an error — when: its capability is
// enabled:false, the caller's X-Plyndi-App-Version is below the capability's minAppVersion, its
// feature id is false in remote-config.json, or the card block itself doesn't validate. Kill
// switches and the catalog agree by construction: this route reads the exact same
// capabilityRegistry and remote-config.json state that POST /v1/ai/run and GET /v1/config do.
//
// Boot-load + in-memory cache + SIGHUP reload + ETag + Cache-Control: no-cache + a permissive
// fallback on a broken config file — this is the same pattern src/routes/config.js already
// established for remote-config.json, reused here rather than invented a second time.
// ============================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const registry = require('../lib/capabilityRegistry');
const { compareVersions } = require('../lib/semver');

const HUB_CONFIG_PATH = path.join(__dirname, '..', 'config', 'hub.json');
const REMOTE_CONFIG_PATH = path.join(__dirname, '..', 'config', 'remote-config.json');

const CARD_TYPES = new Set(['inline', 'sheet', 'link', 'input']);

// Opaque strings the app maps to its own sheets/screens (README.md documents the mapping 2-B
// implements). Adding a new one is a backend+app coordination, same as adding a card type.
const ALLOWED_SHEET_IDS = new Set(['dailyPlan', 'shoppingAssistant']);
const ALLOWED_DESTINATIONS = new Set(['quickAdd', 'travelPlanner', 'fitness']);

// receipt_scan and form_coach both require a photograph, and providerGateway.generate() is
// TEXT-ONLY (Plyndi-AI-Hub-Design.md §10, Phase 1-A known gap). An "inline" or "input" card for
// either would send an image that gets validated and then silently ignored by the provider call,
// producing a confident wrong answer with no error surfaced anywhere. Enforced here independent of
// whatever the capability file's card.type says, so a future editing mistake can't reintroduce a
// silent-wrong-answer card — this capability list is intentionally NOT derived from the
// capability's own declared type.
const IMAGE_ONLY_CAPABILITY_IDS = new Set(['receipt_scan', 'form_coach']);

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

// { en: "...", "zh-Hant": "...", ... } — "en" is mandatory whenever a fallbackText field is
// present at all; other locales fall back to "en" in the app if absent (documented in README.md).
function isValidLocaleMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (!isNonEmptyString(value.en)) return false;
  return Object.values(value).every((v) => typeof v === 'string' && v.length > 0);
}

// ---------------------------------------------------------------------------
// hub.json — sections + static (non-capability) cards. Boot-load, SIGHUP reload, permissive
// fallback on a broken/missing file.
// ---------------------------------------------------------------------------

function isValidHubShape(parsed) {
  return (
    parsed !== null &&
    typeof parsed === 'object' &&
    typeof parsed.hubVersion === 'number' &&
    typeof parsed.ttlSeconds === 'number' &&
    Array.isArray(parsed.sections) &&
    parsed.sections.length > 0 &&
    parsed.sections.every((s) => (
      s && typeof s === 'object' &&
      isNonEmptyString(s.id) &&
      typeof s.order === 'number' &&
      (s.copyKey === null || isNonEmptyString(s.copyKey)) &&
      (s.fallbackText === null || isValidLocaleMap(s.fallbackText))
    )) &&
    (parsed.staticCards === undefined || Array.isArray(parsed.staticCards))
  );
}

// Used only when hub.json itself is missing/malformed — derives a minimal-but-valid set of
// sections straight from whatever `section` ids the (already-validated-elsewhere) capability
// cards actually use, so the app's main Premium screen never goes blank over a config typo.
function fallbackSectionsFromCapabilities() {
  const ids = new Set();
  for (const capability of registry.all()) {
    const card = capability && capability.card;
    if (card && isNonEmptyString(card.section)) ids.add(card.section);
  }
  return [...ids].sort().map((id, index) => ({
    id,
    order: (index + 1) * 10,
    copyKey: null,
    fallbackText: { en: id.charAt(0).toUpperCase() + id.slice(1) },
  }));
}

let hubConfig;
let hubConfigIsFallback = false;

function loadHubConfig() {
  try {
    const raw = fs.readFileSync(HUB_CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!isValidHubShape(parsed)) {
      throw new Error('missing required fields or wrong types');
    }
    hubConfig = {
      hubVersion: parsed.hubVersion,
      ttlSeconds: parsed.ttlSeconds,
      sections: parsed.sections,
      staticCards: Array.isArray(parsed.staticCards) ? parsed.staticCards : [],
    };
    hubConfigIsFallback = false;
    console.log(`[ai/hub] loaded hub.json — hubVersion=${parsed.hubVersion}, ${parsed.sections.length} section(s)`);
  } catch (err) {
    hubConfigIsFallback = true;
    hubConfig = { hubVersion: 0, ttlSeconds: 900, sections: fallbackSectionsFromCapabilities(), staticCards: [] };
    console.error(
      `[ai/hub] FAILED to load hub.json (${err.message}) — serving a minimal catalog derived from ` +
      'the capability cards alone instead. Fix and reload with SIGHUP.'
    );
  }
}

// remote-config.json's feature flags, read independently of routes/config.js (never touch that
// file — see README/PR notes) so a kill switch flip is still honoured here via its own SIGHUP
// reload, without adding a second consumer of config.js's internals.
let remoteFeatures = {};

function loadRemoteFeatures() {
  try {
    const raw = fs.readFileSync(REMOTE_CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    remoteFeatures = (parsed && typeof parsed.features === 'object' && parsed.features) || {};
  } catch (err) {
    // Fails open, same convention routes/config.js documents for its own permissive fallback: an
    // unreadable remote-config.json must never hide every hub card. An empty features map means
    // "no feature id is known to be false", so the kill-switch check below omits nothing.
    remoteFeatures = {};
    console.error(`[ai/hub] FAILED to read remote-config.json for feature flags (${err.message}) — treating all features as enabled.`);
  }
}

loadHubConfig();
loadRemoteFeatures();
// Edit hub.json or remote-config.json on the host and `kill -HUP <pid>` to reload both into the
// running process — no restart/redeploy needed, same convention as config.js and
// capabilityRegistry.js (which registers its own SIGHUP listener for capabilities/*.json).
process.on('SIGHUP', () => {
  loadHubConfig();
  loadRemoteFeatures();
});

// ---------------------------------------------------------------------------
// Card validation — a malformed card is skipped and logged, never a 500 for the rest of the hub.
// ---------------------------------------------------------------------------

function cardValidationError(capabilityId, card) {
  if (!card || typeof card !== 'object') return 'missing "card" block';
  if (!CARD_TYPES.has(card.type)) return `"type" must be one of ${[...CARD_TYPES].join(', ')}`;
  if (IMAGE_ONLY_CAPABILITY_IDS.has(capabilityId) && (card.type === 'inline' || card.type === 'input')) {
    return `image-only capability cannot be type "${card.type}" — providerGateway is text-only, only "link" is allowed`;
  }
  if (!isNonEmptyString(card.section)) return '"section" must be a non-empty string';
  if (typeof card.order !== 'number') return '"order" must be a number';
  if (!isNonEmptyString(card.icon)) return '"icon" must be a non-empty string';
  if (!card.copyKeys || typeof card.copyKeys !== 'object' || Array.isArray(card.copyKeys)) {
    return '"copyKeys" must be an object';
  }
  for (const [field, key] of Object.entries(card.copyKeys)) {
    if (!isNonEmptyString(key)) return `copyKeys.${field} must be a non-empty string`;
  }
  if (card.fallbackText !== null && card.fallbackText !== undefined) {
    if (typeof card.fallbackText !== 'object' || Array.isArray(card.fallbackText)) {
      return '"fallbackText" must be null or an object';
    }
    for (const [field, locales] of Object.entries(card.fallbackText)) {
      if (!isValidLocaleMap(locales)) return `fallbackText.${field} must be an object with a non-empty "en" string`;
    }
  }
  if (card.sheetId !== null && card.sheetId !== undefined && !ALLOWED_SHEET_IDS.has(card.sheetId)) {
    return `"sheetId" must be null or one of ${[...ALLOWED_SHEET_IDS].join(', ')}`;
  }
  if (card.destination !== null && card.destination !== undefined && !ALLOWED_DESTINATIONS.has(card.destination)) {
    return `"destination" must be null or one of ${[...ALLOWED_DESTINATIONS].join(', ')}`;
  }
  // Never gate acceptance on a field a later phase might legitimately add (see the null-leg bug in
  // Plyndi-AI-Hub-Design.md §1.6) — these checks only enforce internal consistency of the four
  // fixed types, not speculative future ones.
  if (card.type === 'sheet' && !card.sheetId) return 'type "sheet" requires a non-null "sheetId"';
  if (card.type === 'link' && !card.destination) return 'type "link" requires a non-null "destination"';
  if (card.type === 'inline' && (card.sheetId || card.destination)) return 'type "inline" must not set "sheetId" or "destination"';
  if (card.type === 'input' && (card.sheetId || card.destination)) return 'type "input" must not set "sheetId" or "destination"';
  return null;
}

// A capability's card is omitted (not an error) when the capability itself is disabled, the
// caller's build is too old, or its feature id is killed — the exact same three gates
// POST /v1/ai/run enforces, so a card the app would refuse to run is never shown in the first
// place. A missing/unparseable caller version fails OPEN, same convention as config.js/aiRun.js.
function isCapabilityVisible(capability, callerVersion) {
  if (!capability.enabled) return false;
  if (compareVersions(callerVersion, capability.minAppVersion) === -1) return false;
  if (remoteFeatures[capability.id] === false) return false;
  return true;
}

function toResponseCard(id, card) {
  return {
    id,
    type: card.type,
    icon: card.icon,
    copyKeys: card.copyKeys,
    fallbackText: card.fallbackText ?? null,
    sheetId: card.sheetId ?? null,
    destination: card.destination ?? null,
  };
}

// ---------------------------------------------------------------------------
// Catalog assembly
// ---------------------------------------------------------------------------

function buildSections(callerVersion) {
  const sectionMeta = new Map(hubConfig.sections.map((s) => [s.id, s]));
  const cardsBySection = new Map();

  function push(sectionId, order, card) {
    if (!cardsBySection.has(sectionId)) cardsBySection.set(sectionId, []);
    cardsBySection.get(sectionId).push({ order, card });
  }

  for (const capability of registry.all()) {
    const rawCard = capability.card;
    const problem = cardValidationError(capability.id, rawCard);
    if (problem) {
      console.error(`[ai/hub] SKIPPING card for capability "${capability.id}": ${problem}`);
      continue;
    }
    if (!isCapabilityVisible(capability, callerVersion)) continue;
    if (!sectionMeta.has(rawCard.section)) {
      console.error(`[ai/hub] SKIPPING card for capability "${capability.id}": section "${rawCard.section}" is not defined in hub.json`);
      continue;
    }
    push(rawCard.section, rawCard.order, toResponseCard(capability.id, rawCard));
  }

  // Pure link cards with no AI capability behind them — e.g. a screen the hub should point at
  // that never calls /v1/ai/run. No enabled/minAppVersion/kill-switch gate applies since there is
  // no capability object to check; they're shown whenever they validate.
  for (const staticCard of hubConfig.staticCards) {
    const id = isNonEmptyString(staticCard && staticCard.id) ? staticCard.id : '(missing id)';
    const problem = cardValidationError(id, staticCard);
    if (problem) {
      console.error(`[ai/hub] SKIPPING static card "${id}": ${problem}`);
      continue;
    }
    if (!sectionMeta.has(staticCard.section)) {
      console.error(`[ai/hub] SKIPPING static card "${id}": section "${staticCard.section}" is not defined in hub.json`);
      continue;
    }
    push(staticCard.section, staticCard.order, toResponseCard(id, staticCard));
  }

  return [...cardsBySection.entries()]
    .map(([id, entries]) => {
      const meta = sectionMeta.get(id);
      return {
        id,
        order: meta.order,
        copyKey: meta.copyKey ?? null,
        fallbackText: meta.fallbackText ?? null,
        cards: entries
          .slice()
          .sort((a, b) => a.order - b.order || a.card.id.localeCompare(b.card.id))
          .map((e) => e.card),
      };
    })
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

const router = express.Router();

router.get('/', (req, res) => {
  const callerVersion = req.appContext ? req.appContext.appVersion : null;
  const sections = buildSections(callerVersion);

  const body = {
    hubVersion: hubConfig.hubVersion,
    ttlSeconds: hubConfig.ttlSeconds,
    sections,
  };

  // ETag covers everything except serverTime, which is set fresh below on every response and
  // would otherwise change the hash (and defeat 304s) on every single request — same reasoning as
  // routes/config.js. Note the body (and therefore the ETag) legitimately varies with the caller's
  // X-Plyndi-App-Version, exactly as config.js's updateRequired/updateRecommended already do.
  const etag = `"${crypto.createHash('sha1').update(JSON.stringify(body)).digest('hex')}"`;
  res.set('ETag', etag);
  // The iOS client keeps its own ttlSeconds disk cache (Plyndi-AI-Hub-Design.md §5), so an HTTP
  // max-age here would stack a second, invisible staleness layer on top of it.
  res.set('Cache-Control', 'no-cache');

  if (req.get('If-None-Match') === etag) {
    res.status(304).end();
    return;
  }

  res.status(200).json({ ...body, serverTime: new Date().toISOString() });
});

module.exports = router;
// Exposed for scripts/test-ai-hub.js only — production code never calls these directly.
module.exports.loadHubConfig = loadHubConfig;
module.exports.loadRemoteFeatures = loadRemoteFeatures;
module.exports.isFallback = () => hubConfigIsFallback;
