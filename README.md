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
- **Run storage is temporary and in-memory** (`src/lib/runStore.js`) — Phase 3 replaces it with
  Render Postgres; Render's own disk is not durable, so a file-backed store would be *worse* than
  today's in-memory one, not a real fix. There is no per-user identity until Phase 3's JWT lands,
  so every run is scoped under one coarse bucket for now — idempotency and `GET /v1/ai/runs` are
  effectively per-deployment, not per-user, until then.
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

## Versioned sync backups

The shared service exposes `POST /v1/sync/backups`, `GET /v1/sync/backups/latest`, and `GET /v1/sync/backups`. Each POST appends a validated Plyndi JSON envelope and retains at most `SYNC_MAX_VERSIONS` versions per verified user. “Latest” is the newest server-stored version; there is no automatic merge, so concurrent devices must use an application-level conflict review before replacing local data. Local erase intentionally does not delete cloud backups, and a cloud-delete endpoint is not implemented yet.

Sync routes default to **verified identity required**. Configure the server-only `SYNC_JWT_SECRET` and send an HS256 bearer token whose `sub` claim is the Plyndi user ID and whose `exp` has not elapsed. The `X-Plyndi-User-ID` header is accepted only when `SYNC_REQUIRE_VERIFIED_IDENTITY=false`, which is a development fallback and is spoofable. The global `X-Plyndi-Client-Key` gate is not user authentication.

The current filesystem store is a development adapter. On Render or any ephemeral host, configure a persistent encrypted disk/object store/database before using personal data. Add ownership-aware deletion, retention policy, conflict resolution, and provider-specific token verification before calling sync production-ready.

