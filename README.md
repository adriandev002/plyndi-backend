# Plyndi Backend

The AI/Places gateway from the build roadmap's Stage 3. The one place `OPENAI_API_KEY`,
`GEMINI_API_KEY`, and `GOOGLE_PLACES_API_KEY` live. Nothing else — no user accounts, no app data,
no database. It exists purely so neither the iOS app nor the future Android app ever ships a real
API key inside the binary.

## What it does

Three small proxy routes, all pass-through by design (the app sends the same request shape it
would have sent straight to Google/OpenAI; this just injects the real key and forwards it):

- `POST /v1/gemini/:model/generate` → Google's Generative Language API
- `POST /v1/openai/chat/completions` → OpenAI's Chat Completions API
- `POST /v1/places/autocomplete`, `POST /v1/places/search` → Google Places API (New)
- `GET /v1/config` → the Phase 0 AI Hub kill switch / version gate (see below)
- `POST /v1/ai/run`, `GET /v1/ai/runs` → the Phase 1-A AI Hub capability registry (see below)
- `GET /v1/ai/hub` → the Phase 2-A server-driven AI Hub catalog (see below)
- `GET /v1/ai/entitlement` → the Phase 3-A credits meter (see below)
- `POST /v1/ai/brief/digest`, `GET /v1/ai/brief` → the Phase 4-A Daily Brief (see below)

Every request (except `/healthz`) must carry an `X-Plyndi-Client-Key` header matching
`CLIENT_SHARED_KEY` — see `src/middleware/auth.js` for what that does and doesn't protect
against. Every request body is sanitized (PII patterns redacted) before it's forwarded upstream
or logged — see `src/middleware/sanitize.js`. Requests are rate-limited per IP — see
`RATE_LIMIT_MAX`/`RATE_LIMIT_WINDOW_MINUTES` below.

## What it deliberately does NOT do yet

Point the iOS app at this server. That's a separate step — it means rewriting
`GeminiClient.swift`, `OpenAIClient.swift`, and `GooglePlacesClient.swift` to call these routes
over plain HTTPS instead of calling Google/OpenAI's SDKs/APIs directly, and removing the
Debug-only key-entry sections from `SettingsView.swift`. This repo only stands the server up —
nothing in the iOS app has been changed to use it yet.

## Local development

```
npm install
cp .env.example .env
# fill in .env: at least one of GEMINI_API_KEY/OPENAI_API_KEY, GOOGLE_PLACES_API_KEY,
# and a CLIENT_SHARED_KEY (generate one with: openssl rand -hex 32)
npm run dev
```

Then, from another terminal:

```
curl http://localhost:3000/healthz
# → ok

curl -X POST http://localhost:3000/v1/gemini/gemini-flash-latest/generate \
  -H "X-Plyndi-Client-Key: <same value as .env's CLIENT_SHARED_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"contents":[{"parts":[{"text":"Say hello in one sentence."}]}]}'
```

## Deploying to Render

You'll need a Render account (render.com) and a place to host this code's git history — a GitHub
repo is the simplest path, since Render's dashboard connects directly to GitHub for auto-deploys
on every push.

1. **Push this folder to its own GitHub repo.** It's a separate deployable service from the iOS
   app, so keep it in its own repo rather than folding it into the Plyndi iOS repo:
   ```
   cd backend
   git init
   git add -A
   git commit -m "Initial Plyndi backend"
   # create an empty repo on github.com first, then:
   git remote add origin <your-new-repo-url>
   git branch -M main
   git push -u origin main
   ```
2. **On Render:** New → Blueprint → connect the GitHub repo you just pushed. Render reads
   `render.yaml` automatically and provisions the service on the $5/mo Starter plan with the
   right build/start commands and health check already configured.
   - If you'd rather not use a Blueprint: New → Web Service → connect the repo → set Build
     Command `npm install`, Start Command `npm start`, Health Check Path `/healthz` by hand.
3. **Set the environment variables** in the Render dashboard (Environment tab) — `render.yaml`
   deliberately leaves these blank (`sync: false`) so Render prompts for them instead of trying
   to read values that don't exist anywhere in the repo:
   - `GEMINI_API_KEY`
   - `OPENAI_API_KEY`
   - `GOOGLE_PLACES_API_KEY`
   - `CLIENT_SHARED_KEY` — generate with `openssl rand -hex 32`; keep this value somewhere safe,
     it also needs to go into the iOS (and later Android) app builds, see below.
4. **Deploy.** Render gives you a URL like `https://plyndi-backend.onrender.com`. Confirm it's
   live: `curl https://plyndi-backend.onrender.com/healthz` should return `ok`.

Render's $5/mo Starter plan doesn't spin down between requests (the free tier does, which would
add a slow "cold start" to every AI feature after a few minutes of no traffic) — Starter is the
right tier for this from day one, not an upgrade-later thing.

## Wiring up the apps

Once deployed, both the iOS app (and later Android) need:

- The server's base URL (`https://plyndi-backend.onrender.com`)
- The same `CLIENT_SHARED_KEY` value, sent as the `X-Plyndi-Client-Key` header on every request

Baking the shared key into an iOS build the same way this project already handles the Places key
("a single restricted key baked into the build at compile time" — see `SettingsView.swift`'s
Debug-only key section comments) is the natural approach: an `.xcconfig`/build setting, not a
runtime Settings field.

## Moving off Render later

If usage ever outgrows a single $5/mo instance, moving to AWS/GCP only means redeploying this
same Express app somewhere else and updating the base URL both apps call — nothing about the
routes, sanitization, or auth changes, since none of it is Render-specific.

## Remote config: kill switch + version gate (Phase 0 AI Hub)

`GET /v1/config` is the single source of truth for the iOS app's `RemoteConfigService`/
`RemoteConfig` (and, later, the Android and Phase 1 clients). It lets per-feature kill switches
and a minimum-app-version gate be flipped from the server, with no App Store release. The client
fails open on every error (no network, malformed response, `GatewayConfig` not configured) — this
endpoint exists to make that graceful default the exception, not the norm.

- **Payload** lives in `src/config/remote-config.json`, loaded into memory at boot and cached
  there. Edit the file on the host and send `kill -HUP <pid>` to reload it into the running
  process — no restart or redeploy needed. Every load (success or failure) is logged.
- **If the file is missing or malformed**, the server logs it loudly and serves a hardcoded
  permissive default (everything enabled, `minSupportedVersion "0.0.0"`) instead of failing the
  request — a broken config file must never brick the app fleet.
- **`updateRequired`/`updateRecommended` are computed per request** from the caller's
  `X-Plyndi-App-Version` header against `minSupportedVersion`/`recommendedVersion` — the client
  does no version comparison of its own. Version comparison is numeric, segment by segment (see
  `src/lib/semver.js`), not a string/lexical compare — `"1.10.0"` is *newer* than `"1.9.0"`, even
  though it sorts before it as a string. A missing or unparseable version header always resolves
  to `updateRequired: false` (fail open).
- **Feature ids are shared with the Phase 1 capability registry and must not be renamed**:
  `ai_hub` (umbrella switch), `budget_insights`, `daily_plan`, `shopping_suggestions`,
  `quick_add_parse`, `receipt_scan`, `trip_itinerary_day`, `workout_plan`, `form_coach`,
  `readiness`. These are already hardcoded at 20+ call sites in the shipping iOS app.
- **Caching**: responds with an `ETag` and honors `If-None-Match` with `304`. `Cache-Control` is
  `no-cache` (revalidate every time), not a `max-age` — the iOS client already runs its own
  `ttlSeconds` disk cache, so an HTTP `max-age` would stack a second, invisible staleness layer on
  top of it and could hide an urgent kill-switch flip inside `URLSession`'s cache.
- **Rate limiting**: this route has its own, more generous limiter and sits outside the general
  `RATE_LIMIT_MAX`/`RATE_LIMIT_WINDOW_MINUTES` limiter in `src/server.js` — a client must never be
  throttled out of finding out that a feature was disabled or an update is required.

Run `node scripts/test-config.js` for a full smoke test (comparator table + a real server boot
covering the version gate, ETag/304, SIGHUP reload, and the corrupted-file fallback).

**Before shipping**: `updateUrl` in `src/config/remote-config.json` is still a placeholder — it
must be replaced with the real App Store link before this is relied on for a forced update.

## AI Hub capability registry (Phase 1-A)

`POST /v1/ai/run` moves AI *content* — prompts, JSON schemas, token budgets — out of the Swift
binary and into `capabilities/*.json` on the backend, so fixing a bad prompt or a token-budget bug
is a 30-second server edit instead of an App Store release. The client sends a capability id and a
context object; it never sends a prompt, a schema, or a model name.

```
POST /v1/ai/run
{ capabilityId, contextVersion, context, idempotencyKey, locale }
→ { runId, status, result, provider, model, latencyMs, capabilityVersion }

GET /v1/ai/runs?limit=&cursor=
→ { runs: [...], nextCursor }
```

- **Capability ids are frozen and shared with `remote-config.json`'s feature flags** — they must
  never be renamed: `budget_insights`, `daily_plan`, `shopping_suggestions`, `quick_add_parse`,
  `receipt_scan`, `trip_itinerary_day`, `workout_plan`, `form_coach`, `readiness` (`ai_hub` is an
  umbrella switch in `remote-config.json`, not a capability — it has no file here). Renaming one
  costs an App Store release the same way a `remote-config.json` feature id would.
- **Registry**: `src/lib/capabilityRegistry.js` loads `capabilities/*.json` at boot, caches in
  memory, and reloads on `kill -HUP <pid>` — the exact same pattern `src/routes/config.js` already
  established for `remote-config.json`. A capability file that fails validation (wrong id, missing
  field, bad `profile`/`maxOutputTokens`) is **skipped with a loud log**, never a boot failure —
  one bad file can't take the other eight down with it.
- **Provider seam**: the model-chain/circuit-breaker/schema-translation logic that used to live
  directly in `src/routes/generate.js` is now `src/lib/providerGateway.js`, a plain module.
  `POST /v1/generate` is a thin HTTP wrapper over it; `POST /v1/ai/run` calls
  `providerGateway.generate()` **directly, in-process** — never a loopback HTTP call to
  `/v1/generate` — so nothing here doubles latency, loses error detail, or breaks if the port or
  auth ever changes. `generate()` takes an injectable `providers` map for tests; production callers
  never pass it, so real traffic is unaffected.
- **Request flow**: unknown capability → `404`; `enabled:false` or the caller's
  `X-Plyndi-App-Version` below the capability's `minAppVersion` → `403` (version comparison reuses
  `src/lib/semver.js`, numeric not lexical, same fail-open-on-unparseable rule as `/v1/config`);
  `context` is validated against the capability's `contextSchema` and size-capped
  (`AI_CONTEXT_MAX_BYTES`, default 20000 bytes) **before any provider call is made** — an invalid
  or oversized context never spends provider quota; a repeated `idempotencyKey` returns the
  previously-stored run instead of calling a provider again.
- **Prompt rendering**: a capability's `userPromptTemplate` supports exactly one substitution
  syntax, `{{context.<dot.path>}}`, and every substituted value is JSON-encoded before insertion
  (see `src/lib/renderPromptTemplate.js`) — this is the actual prompt-injection defense, since
  expense notes, task titles and trip preferences are user-controlled text. The `systemPrompt` is
  never templated against `context` at all. One visible side effect: a plain string value shows up
  quoted inside prose (e.g. `arriving from "Taipei"`) because the same uniform encoding rule
  applies to every value, not just ones embedded in a JSON example block — a deliberate trade for
  having one simple, auditable rule instead of per-field trust decisions.
- **Errors** are mapped to a stable, non-technical code + HTTP status
  (`unknown_capability`/404, `capability_disabled`/403, `app_update_required`/403,
  `invalid_context`/400, `context_too_large`/400, `rate_limited`/429,
  `provider_unavailable`/503, `invalid_provider_response`/502) — a provider's raw error message is
  logged server-side and never echoed to the client.
- **Response validation is deliberately shallow**: the route checks only that the provider's
  output parsed as JSON and is an object. It does not deep-validate against the capability's
  `jsonSchema` or require any particular field to be non-null — gating acceptance on a field a
  later phase legitimately overwrites is exactly the bug that once emptied every itinerary in
  production (a client required `legFromPrevious` on every stop while OpenAI's strict-schema mode
  legitimately returned `null` for it).
- **Run storage was temporary and in-memory** as of this phase (Phase 1-A) — Phase 3-A (see its own
  section below) replaced it with a real storage adapter (`src/lib/store/`) that's in-memory by
  default and Postgres-backed on Render, plus per-subject identity (`src/lib/subject.js`)
  replacing the single coarse bucket every run used to share.
- **Known gap, flagged rather than silently worked around**: `receipt_scan` and `form_coach` are
  vision capabilities (they analyze a photo), but `providerGateway.generate()` only sends text
  (`system`/`user` strings) to Gemini/OpenAI — there is no image parameter. Both capability files
  are ported faithfully (prompt, schema, token budget, and a `contextSchema.imageBase64` field) and
  pass registry validation and the generic request-gating tests, but an actual `imageBase64` value
  sent today is validated and then **silently ignored** — the provider call proceeds on text alone.
  Wiring an image path through `providerGateway` (and deciding `form_coach`'s original
  single-provider/no-retry behavior vs. the generic multi-provider chain) is follow-up work, not
  done in this phase; each file's `contextSchema.imageBase64.description` says so inline.

Run `node scripts/test-ai-run.js` (or `npm test`, which also runs `scripts/test-config.js`) for the
full smoke test: the `toOpenAISchema` before/after refactor diff, all nine capabilities loading, a
malformed file being skipped without taking the others down, the version/enabled/context gates,
idempotency, provider-failure error mapping, and a `/v1/generate` regression check — all against a
real in-process HTTP server with the provider layer stubbed (this environment can't reach
Gemini/OpenAI, and a suite that spends real money per run would be a bad suite regardless).

## AI Hub server-driven catalog (Phase 2-A)

The app's AI Hub screen (`AIHubView.swift`) is still a hardcoded Swift list — three cards and two
cross-links, frozen in the binary. `GET /v1/ai/hub` makes the **server** describe that screen
instead: sections, cards, which capability backs each one, and the localized copy to show. Phase
2-B (not part of this repo) rewrites the iOS view into a renderer over this response. Until 2-B
ships, this endpoint exists and is fully tested but nothing in the app calls it yet — same relationship
Phase 0/1-A had to the app before their own iOS phases landed.

```
GET /v1/ai/hub
→ { hubVersion, ttlSeconds, serverTime,
    sections: [ { id, order, copyKey, fallbackText,
                  cards: [ { id, type, icon, copyKeys, fallbackText, sheetId, destination } ] } ] }
```

### The card contract — frozen once Phase 2-B ships

Phase 2-B hardcodes the card **types** into Swift. A type added later works on old builds with no
release (they just don't render it); a type **renamed** later costs one. There are exactly four,
and this set is not meant to grow casually:

| Type | Behaviour | Requires |
|---|---|---|
| `inline` | runs via `POST /v1/ai/run` in place, result renders inside the card | — |
| `sheet` | opens a named in-app sheet the app already has | non-null `sheetId` |
| `link` | navigates to an existing module screen | non-null `destination` |
| `input` | collects one short text input, then runs via `POST /v1/ai/run` | — |

`brief` (Phase 4's Daily Brief) and `teaser` (Phase 3's credit-exhaustion state) are **not** in this
set — they need infrastructure (a daily cache job, a credit ledger) this phase doesn't build. Adding
them later is a new card type, i.e. an App Store release for 2-B's renderer, same as any other type.

**Not every capability is an `inline` card — this is a design constraint, preserved from
`AIHubView.swift`'s own header comment, not laziness.** Travel and Fitness capabilities that need
more input than a hub card can collect (a trip form, a workout profile) stay honest `link` cards to
where the real feature lives, instead of being faked as inline cards that would immediately need a
form of their own.

**`receipt_scan` and `form_coach` are hardcoded to `link` and validated as such at request time,
independent of whatever their capability file says.** Both need a photograph, and
`providerGateway.generate()` is text-only (see the Phase 1-A section above and
`Plyndi-AI-Hub-Design.md` §10). An `inline` or `input` card for either would send an image that
gets validated by `contextSchema` and then silently ignored by the provider call — a confident
wrong answer with no error surfaced anywhere. `src/routes/aiHub.js`'s `IMAGE_ONLY_CAPABILITY_IDS`
check exists specifically so a future edit to either capability file's `card.type` can't
reintroduce this failure mode; `scripts/test-ai-hub.js` asserts it explicitly.

### Frozen card fields

```jsonc
"card": {
  "type": "inline",                // one of the four types above
  "section": "money",              // must match an id in src/config/hub.json's "sections"
  "order": 10,                     // sort key within its section, stable across calls
  "icon": "chart.line.uptrend.xyaxis",   // SF Symbol name — a display hint only, not validated
  "copyKeys": { "title": "aiBudgetInsights", "subtitle": "aiBudgetInsightsSubtitle" },
  "fallbackText": null,            // see below — null when copyKeys covers every field
  "sheetId": null,                 // required (non-null) when type is "sheet"
  "destination": null              // required (non-null) when type is "link"
}
```

- **`copyKeys`** maps a card field (`title`, `subtitle`) to a real `CopyKey` case name from the
  app's `AppStore.swift` — the app resolves it locally in the caller's language, from the same
  751-key/12-language catalog every other screen uses. A key that doesn't exist renders as nothing
  in the app, so `scripts/test-ai-hub.js` greps `AppStore.swift`'s `enum CopyKey` directly and
  fails the field if the name isn't a real case (see "Verifying copyKeys" below).
- **`fallbackText`**, when a field needs it, is keyed **first by field name, then by locale**:
  `{ "subtitle": { "en": "...", "zh-Hant": "..." } }`. It exists only for copy the app has never
  shipped — `copyKeys` and `fallbackText` are mutually exclusive per field (a field is either a real
  key or new fallback text, never both). `"en"` is mandatory whenever a field appears in
  `fallbackText` at all; the app falls back to `"en"` for any locale it doesn't find a translation
  for. `fallbackText` is `null` (not `{}`) when `copyKeys` already covers every field the card uses.
- **`sheetId`** and **`destination`** are opaque strings 2-B maps to its own sheets/screens. The
  allowed values are fixed here, in `src/routes/aiHub.js`'s `ALLOWED_SHEET_IDS`/
  `ALLOWED_DESTINATIONS`, and independently re-declared in `scripts/test-ai-hub.js` so a drift
  between the route and this table is caught by the test, not just by review:

  | `sheetId` | Maps to |
  |---|---|
  | `dailyPlan` | `DailyPlanSheet` |
  | `shoppingAssistant` | `ShoppingAssistantSheet` |

  | `destination` | Maps to |
  |---|---|
  | `quickAdd` | The Quick Add sheet (`MainTabView.swift`) |
  | `travelPlanner` | The Travel Planner module |
  | `fitness` | The Fitness module |

  Adding a new `sheetId`/`destination` value is safe to ship ahead of the app (an old build that
  doesn't recognize it just can't render that one card's action — same "unknown is not fatal"
  principle the design doc states for card types); it only becomes load-bearing once 2-B's renderer
  is taught to handle it.

### The frozen catalog (what 2-B renders)

| Section | Card id | Type | Destination/Sheet |
|---|---|---|---|
| money | `budget_insights` | inline | — |
| planning | `daily_plan` | sheet | `dailyPlan` |
| planning | `shopping_suggestions` | sheet | `shoppingAssistant` |
| planning | `quick_add_parse` | link | `quickAdd` |
| planning | `receipt_scan` | link | `quickAdd` |
| travel | `trip_itinerary_day` | link | `travelPlanner` |
| fitness | `workout_plan` | link | `fitness` |
| fitness | `form_coach` | link | `fitness` |
| fitness | `readiness` | link | `fitness` |

### `src/config/hub.json` — sections and static cards

```jsonc
{
  "hubVersion": 1,
  "ttlSeconds": 900,
  "sections": [
    { "id": "money", "order": 10, "copyKey": null, "fallbackText": { "en": "Money", "zh-Hant": "財務" } }
    // ...planning / travel / fitness, same shape
  ],
  "staticCards": []   // pure link cards with NO backing AI capability — see below
}
```

No `CopyKey` exists yet for grouping headers like "Money"/"Planning" (they're new UI structure, not
previously shipped screen names), so all four section headers use `fallbackText` rather than a
mismatched reuse of an existing module name. `copyKey`/`fallbackText` on a section follow the exact
same shape and mutual-exclusivity rule as a card field.

**`staticCards`** lets the hub point at a screen with no AI capability behind it at all — a pure
`link` card that isn't gated by any `enabled`/`minAppVersion`/kill-switch check, because there's no
capability object to check. It's empty in this phase (nothing needed one yet); `scripts/test-ai-hub.js`
exercises the mechanism directly by adding and removing one at runtime, so it's proven to work the
first time a real one is needed.

### How a card gets from `capabilities/*.json` to the response

For every capability, in order:

1. **Card shape validation** — `type` is one of the four; `section`/`icon` are non-empty strings;
   `copyKeys` values and `fallbackText` locale maps are well-formed; `sheetId`/`destination` are
   `null` or in the allowed sets above; `sheet` requires `sheetId`, `link` requires `destination`,
   `inline`/`input` require neither. **A card that fails any of this is skipped and logged loudly —
   never a `500` for the rest of the hub.**
2. **The `receipt_scan`/`form_coach` image-only guard** (above) — independent of step 1's generic
   type check.
3. **Visibility gates** — omitted (not an error) if the capability is `enabled:false`, the caller's
   `X-Plyndi-App-Version` is below `minAppVersion`, or its feature id is `false` in
   `remote-config.json`. These are the **exact same three checks** `POST /v1/ai/run` enforces, so a
   card the app would be refused for running is never shown in the first place. A
   missing/unparseable version header fails **open** (card stays visible), same convention as
   `/v1/config` and `/v1/ai/run`.
4. **Section lookup** — a card whose `section` isn't one of `hub.json`'s declared section ids is
   skipped and logged (it would have nowhere to render).

Sections with zero visible cards after all of the above are omitted from the response entirely — an
empty section header is not useful UI. Sections are sorted by `order`, cards within a section by
their own `order`, both stable across repeated calls (ties break on id, so ordering is deterministic
even if two entries share an `order` value).

### Reload, fallback, and caching — the same pattern as `/v1/config`, reused rather than invented twice

- **Boot-load + in-memory cache + `SIGHUP` reload**: editing `hub.json` and sending
  `kill -HUP <pid>` reloads it with no restart. `remote-config.json`'s feature flags are read
  independently here (not by importing anything from `src/routes/config.js`, which this phase does
  not touch) and reload on the same `SIGHUP`. Capability cards reload via
  `capabilityRegistry.js`'s own existing `SIGHUP` listener — nothing new was added there.
- **If `hub.json` is missing or malformed**, the server logs it loudly and serves a minimal catalog
  derived from whatever `section` ids the (independently validated) capability cards actually use —
  never a blank Premium screen over a config typo. `module.exports.isFallback()` reports this state
  for tests; production code never needs it.
- **Caching**: `ETag` + `Cache-Control: no-cache`, `If-None-Match` → `304` — identical reasoning to
  `/v1/config`: the client keeps its own `ttlSeconds` disk cache, so an HTTP `max-age` would stack a
  second, invisible staleness layer on top of it and could hide an urgent card change. The `ETag`
  legitimately varies with the caller's `X-Plyndi-App-Version`, the same way `/v1/config`'s
  `updateRequired`/`updateRecommended` already do.

### Verifying `copyKeys` against the real app

`scripts/test-ai-hub.js` reads the iOS app's `AppStore.swift` directly and greps
`enum CopyKey: String, CaseIterable { ... }` for every `case <name>` it declares, then checks that
every card's `copyKeys` value is one of them. It looks for the file at, in order: the
`PLYNDI_IOS_APPSTORE_SWIFT` env var, `~/Manus/Plyndi/Plyndi/AppStore.swift`, and two `../`-relative
guesses from this repo's root — and **skips this one check (not the whole suite)** with a clear
message if none exist, since a checkout of the separate iOS repo isn't guaranteed to be available
wherever this backend's tests run. On a machine with both repos checked out (as in this phase's own
verification), it runs for real and every one of the nine cards' `copyKeys` passed:

`aiBudgetInsights`, `aiBudgetInsightsSubtitle`, `aiPlanMyDay`, `aiHubOpenLabel` (×2, reused by
`daily_plan` and `shopping_suggestions` — it's the same "Open" label `AIHubView.swift` already
shows under those two today), `aiShoppingSuggestions`, `quickAddTitle`, `aiTravelRecommendations`,
`aiHubAvailableInTravel`, `workoutGenerator`, `formCheck`, `aiHubAvailableInFitness` (×2, reused by
`workout_plan` and `form_coach`), `readinessScore`, `readinessScoreSubtitle`.

**Two cards have no existing `CopyKey` that fits and use `fallbackText` instead** — both are new to
the hub (their capabilities were previously link-only or absent from it entirely, so the app has
never shipped hub-card copy for them):

- `quick_add_parse` — title reuses the real `quickAddTitle` ("Quick Add"), but no existing key
  describes what typing into Quick Add does, so its subtitle is `fallbackText`.
- `receipt_scan` — no existing key names this feature as a hub card at all (only the in-sheet menu
  options "Take Photo"/"Choose from Library"/"Import from Files" exist), so **both** its title and
  subtitle are `fallbackText`.

Run `node scripts/test-ai-hub.js` (or `npm test`, which now also runs it) for the full smoke test:
the `copyKeys` check above, the `receipt_scan`/`form_coach` type guard, a live server exercising the
`enabled`/`minAppVersion`/feature-flag gates with `SIGHUP`-equivalent in-process reloads (no
restart), a malformed card being skipped without taking the other eight down, a missing/corrupt
`hub.json` still serving a valid non-empty catalog, `ETag`/`304`, stable ordering across repeated
calls, and the `staticCards` mechanism actually merging a card in and back out.

## AI credits, per-device identity + global spend cap (Phase 3-A)

The security hole this phase closes: `CLIENT_SHARED_KEY` is baked into every installed build, so
anyone who extracts the IPA can call `POST /v1/ai/run` and spend the OpenAI/Gemini budget with no
account and no limit beyond the per-IP rate limiter. There was no spend ceiling of any kind.

**Identity reality — read this before touching `src/lib/subject.js`.** The app links only
FirebaseAI: there is no Firebase Auth and no Firebase uid. Sign-in is Apple/Google, handled
entirely on-device, and `AuthManager.isPremium` is a client-side `UserDefaults` boolean — not a
server-verifiable fact. **The app sends no `Authorization` header today.** Two consequences:

1. **Backward compatibility is non-negotiable.** Every build already installed sends zero identity
   headers. If `POST /v1/ai/run` started requiring one, every one of those builds would break with
   no fix but an App Store release. `AI_REQUIRE_VERIFIED_IDENTITY` therefore defaults to `false`
   (the opposite of `SYNC_REQUIRE_VERIFIED_IDENTITY`'s strict default — see "Versioned sync
   backups" below) and nothing in this phase enforces it.
2. **This is not per-user entitlement.** Knowing who is genuinely Premium requires server-side
   StoreKit receipt validation, which does not exist. `GET /v1/ai/entitlement`'s `plan` is honestly
   `"unknown"` — never inferred from anything the client sends.

### Identity — `src/lib/subject.js`

Every `POST /v1/ai/run` and `GET /v1/ai/entitlement` call resolves a subject, in order of
confidence, and **never rejects for missing identity while `AI_REQUIRE_VERIFIED_IDENTITY` is
`false` (the default)**:

1. a verified HS256 bearer token (`Authorization: Bearer <jwt>`, `sub` claim, `AI_JWT_SECRET`) →
   `{ subject: <sub>, verified: true }`. Nothing issues one of these today — this exists for a
   future real-account rollout.
2. `X-Plyndi-Device-ID` (Phase 3-B: a stable Keychain-backed UUID the iOS app will start sending) →
   `{ subject: 'dev:'+id, verified: false }`.
3. neither → `{ subject: 'anon:'+hash(ip), verified: false }`, a coarse fallback so at least all
   requests from one caller share a bucket.

The HS256 verification logic is **lifted into `src/lib/hs256Subject.js`** out of
`src/routes/sync.js`, which already had a correct, tested verifier (`verifiedJwtSubject`) for its
own per-user bearer tokens — reused rather than reinvented. **`/v1/sync`'s own behaviour is
unchanged**: same secret (`SYNC_JWT_SECRET`), same default (`SYNC_REQUIRE_VERIFIED_IDENTITY=true`),
same `X-Plyndi-User-ID` fallback; it just calls through the shared module now. `/v1/ai/run` uses a
separate secret (`AI_JWT_SECRET`) and the opposite default, because it is a different trust
decision for a different surface.

`verified` is stored on every run and ledger row precisely so a future real-account system can
tell genuine verified subjects apart from device ids later, without a data migration — nothing
today infers anything from it.

### Storage adapter — `src/lib/store/`

One method surface, two implementations, chosen automatically by `DATABASE_URL`'s presence
(`src/lib/store/index.js`): `saveRun`, `getRun`, `findByIdempotency`, `listRuns`, `recordCredit`,
`creditsUsed`, `globalSpendToday` — every method returns a Promise on both adapters, so route code
never knows which one is live.

- **`memoryStore.js`** — what Phase 1-A's `runStore.js` already did for run storage (bounded +
  TTL, `AI_RUN_STORE_MAX`/`AI_RUN_STORE_TTL_MS`), plus a new in-memory credit ledger
  (`AI_CREDIT_LEDGER_MAX`/`AI_CREDIT_LEDGER_TTL_MS`). Used whenever `DATABASE_URL` is unset, and by
  every test in this repo — this environment has no local Postgres to test against (see below).
- **`postgresStore.js`** — `pg`-backed (the one npm dependency this phase adds; there is no way to
  speak the Postgres wire protocol without a client library). Used whenever `DATABASE_URL` is set.

**A missing `DATABASE_URL` must never take the AI Hub down** — it falls back to the in-memory
adapter and logs loudly (`[store] DATABASE_URL is NOT set — ...`) that runs and credits are not
durable, rather than refusing to boot. The AI Hub is the app's Premium screen; a missing database
is a real problem worth fixing, but is not a reason to serve nothing.

### `db/schema.sql` + `scripts/migrate.js`

Three tables — `ai_runs`, `ai_credit_ledger`, `users_ai` — with a **unique index on
`(scope_key, idempotency_key)`**. That index *is* the idempotency guarantee: `postgresStore.js`
relies on losing an `INSERT ... ON CONFLICT DO NOTHING` race and reading back the winning row,
never on a read-then-write check in application code, which would have a race window of its own.
Every statement is `CREATE ... IF NOT EXISTS`, so `node scripts/migrate.js` (or `npm run migrate`)
is safe to run on every deploy, including against an already-migrated database.

### `creditCost` in `capabilities/*.json`

Added the same way Phase 2-A added `card` — one new field per file, nothing else touched (prompts,
schemas, profiles, token budgets and card blocks are byte-identical to before this phase):

| Capability | `creditCost` |
|---|---|
| `budget_insights`, `daily_plan`, `shopping_suggestions`, `quick_add_parse`, `readiness` | 1 |
| `receipt_scan`, `form_coach` | 2 |
| `trip_itinerary_day`, `workout_plan` | 3 |

`src/lib/capabilityRegistry.js` now also validates that `creditCost` is a positive integer — a
capability file that omits or botches it is skipped with a loud log at boot, the same as any other
required field, rather than silently running for free in production.

### `POST /v1/ai/run` — what changed

In request order: capability/version/context gates are unchanged from Phase 1-A, then —

1. **resolve subject** (above) — replaces the single `ANONYMOUS_SCOPE` constant every request used
   to share; it is now the store's `scopeKey` and also scopes `GET /v1/ai/runs`.
2. **idempotency check** — unchanged in effect, now scoped per-subject instead of globally; a
   replay short-circuits before either check below, so it can never itself trip either one.
3. **global daily spend cap** (`AI_DAILY_CREDIT_CAP`, default 2000) — checked **before the provider
   is ever called**, summed across every subject for the current UTC day. Over → `429
   daily_capacity_reached`, provider never reached. This is the one limit that enforces
   unconditionally, no flag, from day one — the catastrophic case (a leaked `CLIENT_SHARED_KEY`
   draining the month's budget overnight) is exactly what a cap that only logs would fail to stop.
   The first trip each UTC day is logged loudly; subsequent trips the same day are not, so a
   sustained overage doesn't spam the log.
4. **per-subject monthly allowance** (`AI_MONTHLY_CREDIT_ALLOWANCE`, default 15) — **shadow mode by
   default** (`AI_CREDITS_ENFORCE=false`): an over-allowance subject is logged
   (`console.warn(...over its monthly allowance...)`) and **still served**. Only when
   `AI_CREDITS_ENFORCE=true` does it return `402 credits_exhausted` with
   `creditsUsed`/`creditsIncluded`/`creditsRemaining`/`periodStart`/`periodEnd`. The first guess at
   credit pricing is always wrong; real usage data has to exist before enforcement is worth turning
   on.
5. on success, the ledger is debited **after** the run succeeds — a failed/rejected/capped request
   never reaches the debit, so nothing is ever charged for a run that didn't happen.

Both the enforce flag and the daily cap are read fresh from `process.env` on every request (the
same choice `src/middleware/auth.js` already makes for `CLIENT_SHARED_KEY`), not cached once at
module load — this is what lets `scripts/test-ai-credits.js` exercise both settings of each flag
against one already-listening server instead of spawning a process per scenario, and it also means
either can be changed on a live server without a restart if the process supports live env updates.

### `GET /v1/ai/entitlement`

```
GET /v1/ai/entitlement
→ { plan, creditsIncluded, creditsUsed, creditsRemaining, periodStart, periodEnd, enforcing }
```

`plan` is always `"unknown"` — see "Identity reality" above for why inferring Premium from the
client would defeat the entire point of this phase. `enforcing` mirrors `AI_CREDITS_ENFORCE` so the
app can render an honest meter instead of guessing. Nothing here refuses anything; `POST
/v1/ai/run` is the only place enforcement (when on) actually happens.

### Testing — `scripts/test-ai-credits.js`

Plain Node, no framework, the provider layer stubbed, run entirely against the in-memory store
(`DATABASE_URL` is explicitly deleted at the top of the script). Covers: a request with zero
identity headers still succeeding (the shipped-build regression), subject-resolution precedence
and that `verified` is recorded correctly, ledger totals matching `creditCost` across a mixed run
of capabilities, an idempotent replay charging once not twice, `AI_CREDITS_ENFORCE=false` letting
an over-allowance subject through with the overage logged, the same subject getting `402` once
`AI_CREDITS_ENFORCE=true`, the global spend cap tripping `429` for a third, distinct subject with
the provider call count at zero, and the `DATABASE_URL`-unset boot warning. Run with
`node scripts/test-ai-credits.js` (or `npm test`, which now runs all four suites in sequence).

### What's verified vs. what isn't

**Verified in this repo, by running the suites above:** every code path against the in-memory
store — all nine scenarios in `scripts/test-ai-credits.js`, plus all three pre-existing suites
still passing (`npm test`), plus `node --test test/sync.test.js` confirming `/v1/sync`'s behaviour
is byte-identical after the verifier extraction.

**NOT verified — no Postgres is reachable from this development environment** (no `psql`/
`pg_isready` on `PATH`, no network path to any Postgres server, including Render's): every query in
`src/lib/store/postgresStore.js`, the `ON CONFLICT ... DO NOTHING` idempotency race handling, and
`scripts/migrate.js` actually applying `db/schema.sql`. All of it was written directly against the
schema and reviewed line by line, but **has never executed against a live server**. Before trusting
it in production: provision Postgres (below), run the migration, then run one real
`POST /v1/ai/run` and confirm rows land in `ai_runs` and `ai_credit_ledger`.

### Render provisioning steps (the user must do these)

1. **Render dashboard → New → PostgreSQL.** Pick a plan (the free 90-day instance is fine to start
   verifying with; a paid plan is required before this is load-bearing for real users, since the
   free tier is deleted after 90 days).
2. **Copy the "Internal Database URL"** Render shows you (not the external one — the backend
   service and the database run in the same Render private network) into the backend web service's
   **Environment** tab as `DATABASE_URL`.
3. **Set the other Phase 3-A variables** in the same Environment tab — at minimum
   `AI_CREDITS_ENFORCE=false` and `AI_MONTHLY_CREDIT_ALLOWANCE`/`AI_DAILY_CREDIT_CAP` if the
   `.env.example` defaults don't fit; leave `AI_JWT_SECRET` unset until a real account system
   exists.
4. **Run the migration once** — either add `node scripts/migrate.js` as a Render **Pre-Deploy
   Command** (so it runs idempotently on every future deploy too, which is the recommended
   long-term setup), or run it one time from a Render Shell / your own machine with `DATABASE_URL`
   pointed at the new instance: `DATABASE_URL=<the connection string> npm run migrate`.
5. **Deploy**, then confirm `[store] DATABASE_URL is set — using the Postgres-backed store` appears
   in the Render logs instead of the in-memory warning, and that a real
   `POST /v1/ai/run`/`GET /v1/ai/entitlement` round trip works end to end.

### Phase 3-B (iOS) — what it must send

Not part of this repo. The next iOS phase needs to:

- Generate a stable UUID once, store it in the Keychain (not `UserDefaults` — it must survive an
  app reinstall's `UserDefaults` reset the same way other Keychain-backed identifiers in this app
  already do), and send it as `X-Plyndi-Device-ID` on every `POST /v1/ai/run` and
  `GET /v1/ai/entitlement` call.
- Render `GET /v1/ai/entitlement`'s response as a credits meter (Plyndi-AI-Hub-Design.md §3.5) —
  `enforcing:false` today means the meter is informational only, nothing is actually refused yet.
- Handle `402 credits_exhausted` (once `AI_CREDITS_ENFORCE` is eventually flipped on) and `429
  daily_capacity_reached` with real user-facing copy — neither exists in the app today because
  neither could happen before this phase.

## Daily Brief (Phase 4-A)

One short server-generated paragraph per user per day, stitching their modules together —
"You're NT$2,400 over pace on dining this month. 3 tasks due today, one overdue. Your Osaka trip
starts in 9 days — 4 packing items still unchecked." Every other AI Hub feature waits to be asked;
this one arrives. Two constraints shape the whole design (Plyndi-AI-Hub-Design.md §3.1):

1. **The server cannot read the user's data.** Everything lives on-device; `/v1/sync` has zero
   call sites. The app POSTs a small digest and the server generates from that alone. No digest is
   a normal state (`204`), not an error.
2. **One provider call per user per day, cached.** A brief regenerated on every app open would
   cost more than every other capability combined — the cache key IS the feature's economics.

```
POST /v1/ai/brief/digest
{ localDate, timeZone, digest }
→ 200 { stored: true, localDate }

GET /v1/ai/brief?localDate=YYYY-MM-DD
→ 200 { brief, localDate, generatedAt, cached, provider, model }
→ 204 (empty body) — no digest posted yet for this (subject, localDate); the normal first-run state
→ 400 { error: "invalid_local_date" | "invalid_time_zone" | "invalid_context" | "context_too_large" }
→ 403 { error: "capability_disabled" | "app_update_required" }
→ 429 { error: "daily_capacity_reached" | "rate_limited" }
→ 502 { error: "invalid_provider_response" }
→ 503 { error: "service_unavailable" | "provider_unavailable" }
```

`POST /v1/ai/brief/digest` **only ever stores** — it never calls a provider, so a background
sync the user never sees the result of can never cost money. `GET /v1/ai/brief` is the only path
that generates, and only the first time it's called for a given `(subject, localDate)`; every
call after that (same day) returns the cached row with `cached: true` and no provider call.

### The digest — exact field names Phase 4-B (iOS) must build against

`digest` is validated against `capabilities/daily_brief.json`'s `contextSchema` — every field is
optional (a user with no trips and no overdue tasks still gets a brief, an honest one):

```jsonc
{
  "locale": "zh-Hant",                          // optional; null/absent -> the brief is in English
  "spend": {                                     // optional; omit entirely if unknown
    "status": "over",                            // "over" | "under" | "onPace"
    "amount": 2400,                               // in the given currency
    "currencySymbol": "NT$",
    "category": "dining"                          // null/absent if it's an overall total, not one category
  },
  "tasks": { "dueTodayCount": 3, "overdueCount": 1 },   // optional
  "trip": { "name": "Osaka", "daysUntil": 9 },          // optional; omit if no upcoming trip
  "packing": { "uncheckedCount": 4 }                    // optional
}
```

`locale` lives **inside** `digest`, not as a sibling of `localDate`/`timeZone` — this is what lets
`GET /v1/ai/brief` stay a plain `?localDate=` lookup with no separate locale parameter: the locale
that was current when the digest was posted is the locale the brief gets generated in. Every
field the model is told about explicitly allows `null`; the prompt is instructed to omit any
topic that's entirely null rather than invent or pad around it, and to respond with a single
honest, neutral line (never invented praise) when the whole digest is empty.

### "Today" is the USER's day, never UTC

The client sends its own `localDate` (`YYYY-MM-DD`) and `timeZone` (IANA, e.g. `Asia/Taipei`) —
**the cache key `src/lib/store/*.js`'s `saveBrief`/`getBrief` use is `(subject, localDate)`
alone**, not UTC. A brief cached under a UTC date would arrive at 8am in Taipei (UTC+8) labelled
with yesterday's numbers, and would regenerate mid-morning when UTC rolls over — `timeZone` is
validated (a real IANA zone, via `Intl.DateTimeFormat`) but is informational only, not part of the
key. `localDate` is validated strictly (`^\d{4}-\d{2}-\d{2}$`, and a real calendar date — a
syntactically-shaped but impossible date like `2026-02-30` is rejected) and refused if it's more
than **2 days** from the server's own UTC date (`src/routes/aiBrief.js`'s
`LOCAL_DATE_TOLERANCE_DAYS`) — wide enough to cover every real UTC offset, narrow enough that a
bad or hostile client can't mint unlimited cache entries and, through them, unlimited attempted
provider calls.

### Free to the user, NOT free to us

`capabilities/daily_brief.json`'s `creditCost` is `0` — the brief is free for every user
(Plyndi-AI-Hub-Design.md §6), so it never draws down a subject's monthly allowance
(`AI_MONTHLY_CREDIT_ALLOWANCE`). But a generation is still a real provider call, so it must count
toward the **global daily spend cap** (`AI_DAILY_CREDIT_CAP`) exactly like every other capability.
This is the one thing in this phase that's easy to get backwards, so it's implemented as two
separate, deliberately-named fields and one ledger flag, not one field doing double duty:

- **`creditCost` (0)** — what `POST /v1/ai/run` would charge a subject's monthly allowance. Never
  read for billing purposes here, because...
- **daily_brief is never routed through `POST /v1/ai/run` at all.** `src/lib/capabilityRegistry.js`
  deliberately does not load `capabilities/daily_brief.json` — see that file's header comment. If
  it were loaded there, `POST /v1/ai/run` would happily accept `capabilityId: "daily_brief"` and
  charge/cap it by `creditCost`, which is `0` — meaning **neither** the per-subject allowance
  **nor** the global cap check (`spentToday + creditCost > dailyCap`, and `0` never trips it) would
  ever refuse it, i.e. unlimited, uncached, free provider calls through the generic endpoint.
  `src/routes/aiBrief.js` loads and validates `capabilities/daily_brief.json` itself instead, with
  its own small loader (same boot-load/SIGHUP-reload shape as every other loader in this repo).
- **`globalSpendCost` (a required, positive integer, currently `1`)** — the real per-generation
  cost weight `GET /v1/ai/brief` actually checks against `AI_DAILY_CREDIT_CAP` and records to the
  ledger. Independent of `creditCost` on purpose.
- **`store.recordCredit(..., countsTowardAllowance: false)`** — the ledger row this route writes
  passes `countsTowardAllowance: false`. `src/lib/store/*.js`'s `globalSpendToday()` is unscoped
  and sums every row regardless of this flag (so the brief's spend is always in the global total);
  `creditsUsed(subject, periodStart)` — the per-subject monthly-allowance lookup — now filters on
  it, so this one row is invisible to that query. See `db/schema.sql`'s `counts_toward_allowance`
  column comment and `src/lib/store/memoryStore.js`/`postgresStore.js`'s `recordCredit`/
  `creditsUsed` comments. Every pre-Phase-4-A caller (i.e. every `POST /v1/ai/run` charge) omits
  this field, so it defaults to `true` and behaves exactly as before — this is a pure addition to
  the store interface, not a second storage path.

### `maxOutputTokens` — sized for one short paragraph, not a full analysis

`1024`, well under the `4096` every other `fast` capability uses — the brief is ONE short
paragraph (2-4 sentences), not a multi-field analysis. Sized for: the actual prose (roughly
100-160 tokens for a 50-80 word English paragraph), doubled for the worst-case non-Latin locale
(this repo's own prior measurement: non-Latin output roughly doubles token count for equivalent
content — see the Phase 2-A section above), plus the small fixed JSON-wrapper overhead and a
buffer against the token-budget failure class documented in Plyndi-AI-Hub-Design.md §1.6 (thinking
tokens sharing the output budget). `temperature` is `0.3`, lower than every other capability's
`0.4-0.6`, because a factual one-liner with an explicit "never invent a number" instruction has
much less to gain from variety and much more to lose from a hallucinated fact.

### `ai_briefs` table + store methods

One row per `(subject, local_date)` — see `db/schema.sql`'s comment for the exact columns.
`PRIMARY KEY (subject, local_date)` **is** the once-per-user-per-day guarantee: `saveBrief`
(added to both `src/lib/store/memoryStore.js` and `postgresStore.js`, alongside the existing
`saveRun`/`getRun`/.../`globalSpendToday` surface — no second storage path) is a single upsert
used from two different call sites with different fields populated:

- `POST /v1/ai/brief/digest` passes `{ subject, localDate, digest }` — `digest_json` is
  overwritten whenever supplied (a repost always takes effect), `brief_text`/`provider`/`model`
  are left untouched.
- `GET /v1/ai/brief`'s generation path passes `{ subject, localDate, briefText, provider, model }`
  — `brief_text`/`provider`/`model` are only ever set once: on Postgres via
  `COALESCE(ai_briefs.brief_text, EXCLUDED.brief_text)` (existing value wins), so nothing written
  afterward — including a same-day digest repost, which passes `briefText` as `undefined` — can
  ever blank out or replace an already-generated brief. The in-memory store mirrors this exactly.

Retention: briefs older than ~90 days are prunable (`db/schema.sql`'s `ai_briefs_created_at`
index is what a future prune job would scan) — no automatic job runs yet in this phase, same as
`ai_runs`' documented-but-not-cron-enforced 12-month retention; this repo's anti-goals explicitly
rule out adding a cron here. The in-memory adapter self-bounds via `AI_BRIEF_STORE_MAX`/
`AI_BRIEF_STORE_TTL_MS` (defaults: 5000 entries / 90 days) the same way `AI_RUN_STORE_MAX`/
`AI_RUN_STORE_TTL_MS` already do for runs.

### Known, accepted race: two simultaneous first-of-day `GET`s

Unlike `POST /v1/ai/run`, `GET /v1/ai/brief` has no `idempotencyKey` — there's nothing for the
client to supply one from, since the request is a plain cache lookup, not an action. Two
concurrent first-of-day `GET`s for the same `(subject, localDate)` can therefore both reach the
"no brief cached yet" branch and both call the provider before either has saved. The upsert
ensures the **cache is still correct** (only the first write's `brief_text` is ever kept — see
above), but a same-instant race can spend twice against the global cap. Accepted as a rare,
bounded edge case for this phase: a normal client only ever issues one such `GET` per
app-foreground per day.

### Testing — `scripts/test-ai-brief.js`

Plain Node, no framework, the provider layer stubbed, run entirely against the in-memory store —
same shape as `scripts/test-ai-credits.js`. Covers: a digest `POST` storing without generating
(provider call count `0`); the first `GET` generating once and a second `GET` for the same
`localDate` returning the cached result with the call count still `1`; a different `localDate`
generating again; no digest posted yet returning `204` with no provider call; re-posting a digest
neither invalidating an existing brief nor re-billing it; the brief leaving
`GET /v1/ai/entitlement`'s `creditsUsed` at `0` while still visibly incrementing
`globalSpendToday()`; the global cap rejecting a second subject once exhausted, with the provider
never called; `daily_brief` disabled via `remote-config.json`'s feature flag (SIGHUP-equivalent
in-process reload, same technique `scripts/test-ai-hub.js` uses) refusing with no provider call and
recovering once re-enabled; and a battery of bad/absent/far-future `localDate`/`timeZone` values
all rejected with zero provider calls. Run with `node scripts/test-ai-brief.js` (or `npm test`,
which now runs all five suites in sequence).

### What's verified vs. what isn't

**Verified in this repo:** every scenario above, against the in-memory store — this environment
has no local Postgres and no network path to Render's (same limitation Phase 3-A's README section
already documents). All five suites pass (`npm test`).

**NOT verified — no Postgres reachable from this environment:** `ai_briefs`' `saveBrief`/
`getBrief` queries in `src/lib/store/postgresStore.js`, the `ON CONFLICT` upsert's COALESCE
semantics under real concurrent writes, `ai_credit_ledger`'s new `counts_toward_allowance` column
actually landing via `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` against the **already-migrated,
live** Render database (this is the first schema change since Phase 3-A's initial `CREATE TABLE`,
so it's the first real test of `scripts/migrate.js`'s idempotent-upgrade path, not just its
idempotent-no-op path). Before trusting this in production: run `node scripts/migrate.js` against
the live `DATABASE_URL`, confirm the log names `ai_briefs`, then confirm
`\d ai_credit_ledger` shows `counts_toward_allowance` and a real `POST /v1/ai/brief/digest` +
`GET /v1/ai/brief` round trip lands a row in `ai_briefs` and a `counts_toward_allowance = false`
row in `ai_credit_ledger`.

### Known, deliberate gap: no card in `GET /v1/ai/hub`

`capabilities/daily_brief.json` has no `card` field, so it never appears in the `GET /v1/ai/hub`
catalog (`src/routes/aiHub.js`'s `cardValidationError` skips it with one harmless, expected
`SKIPPING card for capability "daily_brief": missing "card" block` log line per hub request — not
a bug). This matches the design doc precisely: `brief` is explicitly **not** one of Phase 2-B's
four frozen card types (`inline`/`sheet`/`link`/`input`), and adding it is described as its own
future App Store release for the renderer. Surfacing the Daily Brief in the app is Phase 4-B's
job, entirely outside this repo. `src/routes/aiHub.js` and `src/config/hub.json` are untouched by
this phase.

### Phase 4-B (iOS) — what it must build against

Not part of this repo. The next iOS phase needs to: build the digest from `AppStore`'s own data
(spend vs. category budgets/pace, todo due/overdue counts, next trip + days out, unchecked packing
count) in exactly the shape documented above; `POST` it on app background/foreground with the
device's own `localDate`/`timeZone`/`locale`; call `GET /v1/ai/brief?localDate=<today>` on
foreground and render `brief` (handling `204` as "nothing to show yet", not an error); and decide
whether a morning local/push notification rides on the existing background-refresh hook or needs
its own budget (Plyndi-AI-Hub-Design.md §8, item 7 — explicitly still open). This repo adds no
push/APNs capability of any kind; the app has none today.

## Versioned sync backups

The shared service exposes `POST /v1/sync/backups`, `GET /v1/sync/backups/latest`, and `GET /v1/sync/backups`. Each POST appends a validated Plyndi JSON envelope and retains at most `SYNC_MAX_VERSIONS` versions per verified user. “Latest” is the newest server-stored version; there is no automatic merge, so concurrent devices must use an application-level conflict review before replacing local data. Local erase intentionally does not delete cloud backups, and a cloud-delete endpoint is not implemented yet.

Sync routes default to **verified identity required**. Configure the server-only `SYNC_JWT_SECRET` and send an HS256 bearer token whose `sub` claim is the Plyndi user ID and whose `exp` has not elapsed. The `X-Plyndi-User-ID` header is accepted only when `SYNC_REQUIRE_VERIFIED_IDENTITY=false`, which is a development fallback and is spoofable. The global `X-Plyndi-Client-Key` gate is not user authentication.

The current filesystem store is a development adapter. On Render or any ephemeral host, configure a persistent encrypted disk/object store/database before using personal data. Add ownership-aware deletion, retention policy, conflict resolution, and provider-specific token verification before calling sync production-ready.

