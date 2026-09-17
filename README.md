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

## Versioned sync backups

The shared service exposes `POST /v1/sync/backups`, `GET /v1/sync/backups/latest`, and `GET /v1/sync/backups`. Each POST appends a validated Plyndi JSON envelope and retains at most `SYNC_MAX_VERSIONS` versions per verified user. “Latest” is the newest server-stored version; there is no automatic merge, so concurrent devices must use an application-level conflict review before replacing local data. Local erase intentionally does not delete cloud backups, and a cloud-delete endpoint is not implemented yet.

Sync routes default to **verified identity required**. Configure the server-only `SYNC_JWT_SECRET` and send an HS256 bearer token whose `sub` claim is the Plyndi user ID and whose `exp` has not elapsed. The `X-Plyndi-User-ID` header is accepted only when `SYNC_REQUIRE_VERIFIED_IDENTITY=false`, which is a development fallback and is spoofable. The global `X-Plyndi-Client-Key` gate is not user authentication.

The current filesystem store is a development adapter. On Render or any ephemeral host, configure a persistent encrypted disk/object store/database before using personal data. Add ownership-aware deletion, retention policy, conflict resolution, and provider-specific token verification before calling sync production-ready.

