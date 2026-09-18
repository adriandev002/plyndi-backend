// Loads and validates capabilities/*.json at boot, caches in memory, reloads on SIGHUP — same
// pattern src/routes/config.js already established for remote-config.json, reused rather than
// invented twice.
//
// The nine capability ids are FROZEN (Plyndi-AI-Hub-Design.md §10): they're already hardcoded in
// shipped Swift call sites and in remote-config.json's feature flags. A capability file whose id
// isn't one of these nine (or whose filename doesn't match its own id) fails validation.
//
// A malformed capability file is SKIPPED with a loud log, never a boot failure — one bad file
// must not take the other eight down with it, same reasoning config.js's permissive fallback
// documents for remote-config.json.
//
// Phase 4-A note: `daily_brief` (Plyndi-AI-Hub-Design.md §3.1) is DELIBERATELY NOT loaded through
// this registry, even though capabilities/daily_brief.json exists and follows the same file
// shape. Every capability loaded here is automatically callable through the generic
// POST /v1/ai/run — which charges (and caps) purely by `creditCost`. daily_brief's `creditCost`
// is 0 (it's free for every user, §6) but it still spends real provider quota per Phase 4-A's
// own once-per-user-per-day cache; routing it through POST /v1/ai/run would let a caller trigger
// unlimited, uncached generations that cost 0 against both the per-subject allowance AND the
// global daily cap (aiRun.js's cap check adds `creditCost`, so a 0-cost capability never trips
// it). src/routes/aiBrief.js loads and validates capabilities/daily_brief.json itself instead,
// with its own cache key and its own global-cap accounting — see that file's header comment.

const fs = require('fs');
const path = require('path');

const CAPABILITIES_DIR = path.join(__dirname, '..', '..', 'capabilities');

const FROZEN_CAPABILITY_IDS = new Set([
  'budget_insights',
  'daily_plan',
  'shopping_suggestions',
  'quick_add_parse',
  'receipt_scan',
  'trip_itinerary_day',
  'workout_plan',
  'form_coach',
  'readiness',
]);

let capabilities = new Map();

function validationError(id, parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'not a JSON object';
  if (parsed.id !== id) return `"id" field ("${parsed.id}") does not match filename ("${id}.json")`;
  if (!FROZEN_CAPABILITY_IDS.has(parsed.id)) return `"${parsed.id}" is not one of the nine frozen capability ids`;
  if (typeof parsed.version !== 'number' || !Number.isFinite(parsed.version)) return '"version" must be a number';
  if (parsed.profile !== 'fast' && parsed.profile !== 'rich') return '"profile" must be "fast" or "rich"';
  if (!Number.isInteger(parsed.maxOutputTokens) || parsed.maxOutputTokens <= 0) {
    return '"maxOutputTokens" must be a positive integer';
  }
  // Phase 3-A (Plyndi-AI-Hub-Design.md §6) — debited from the caller's monthly allowance by
  // src/routes/aiRun.js. Required so every run has a well-defined cost; a capability author who
  // forgets it gets a loud SKIPPING log at boot, the same as forgetting any other required field,
  // rather than a silent free run in production.
  if (!Number.isInteger(parsed.creditCost) || parsed.creditCost <= 0) {
    return '"creditCost" must be a positive integer';
  }
  if (typeof parsed.enabled !== 'boolean') return '"enabled" must be a boolean';
  if (typeof parsed.minAppVersion !== 'string' || !parsed.minAppVersion) return '"minAppVersion" must be a non-empty string';
  if (typeof parsed.systemPrompt !== 'string' || !parsed.systemPrompt) return '"systemPrompt" must be a non-empty string';
  if (typeof parsed.userPromptTemplate !== 'string' || !parsed.userPromptTemplate) {
    return '"userPromptTemplate" must be a non-empty string';
  }
  if (!parsed.jsonSchema || typeof parsed.jsonSchema !== 'object') return '"jsonSchema" must be an object';
  if (!parsed.contextSchema || typeof parsed.contextSchema !== 'object') return '"contextSchema" must be an object';
  return null;
}

function loadCapabilities() {
  const next = new Map();
  let files;
  try {
    files = fs.readdirSync(CAPABILITIES_DIR).filter((name) => name.endsWith('.json'));
  } catch (err) {
    console.error(`[capabilities] FAILED to read ${CAPABILITIES_DIR} (${err.message}) — no capabilities loaded.`);
    capabilities = next;
    return;
  }

  // Phase 4-A: daily_brief.json is intentionally excluded here (not an error) — see this file's
  // header comment. src/routes/aiBrief.js loads it separately.
  const consideredFiles = files.filter((file) => path.basename(file, '.json') !== 'daily_brief');

  for (const file of consideredFiles) {
    const id = path.basename(file, '.json');
    try {
      const raw = fs.readFileSync(path.join(CAPABILITIES_DIR, file), 'utf8');
      const parsed = JSON.parse(raw);
      const problem = validationError(id, parsed);
      if (problem) throw new Error(problem);
      next.set(id, parsed);
    } catch (err) {
      console.error(`[capabilities] SKIPPING ${file}: ${err.message}`);
    }
  }

  capabilities = next;
  console.log(`[capabilities] loaded ${capabilities.size}/${consideredFiles.length} capability file(s): ${[...capabilities.keys()].sort().join(', ') || '(none)'}`);
}

loadCapabilities();
// Edit a capabilities/*.json file on the host and `kill -HUP <pid>` to reload it into the
// running process — no restart/redeploy needed, same as remote-config.json.
process.on('SIGHUP', loadCapabilities);

function get(id) {
  return capabilities.get(id) || null;
}

function all() {
  return [...capabilities.values()];
}

module.exports = { get, all, loadCapabilities, FROZEN_CAPABILITY_IDS };
