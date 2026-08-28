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

## Versioned sync backups

The shared service exposes `POST /v1/sync/backups`, `GET /v1/sync/backups/latest`, and `GET /v1/sync/backups`. Each POST appends a validated Plyndi JSON envelope and retains at most `SYNC_MAX_VERSIONS` versions per verified user. “Latest” is the newest server-stored version; there is no automatic merge, so concurrent devices must use an application-level conflict review before replacing local data. Local erase intentionally does not delete cloud backups, and a cloud-delete endpoint is not implemented yet.

Sync routes default to **verified identity required**. Configure the server-only `SYNC_JWT_SECRET` and send an HS256 bearer token whose `sub` claim is the Plyndi user ID and whose `exp` has not elapsed. The `X-Plyndi-User-ID` header is accepted only when `SYNC_REQUIRE_VERIFIED_IDENTITY=false`, which is a development fallback and is spoofable. The global `X-Plyndi-Client-Key` gate is not user authentication.

The current filesystem store is a development adapter. On Render or any ephemeral host, configure a persistent encrypted disk/object store/database before using personal data. Add ownership-aware deletion, retention policy, conflict resolution, and provider-specific token verification before calling sync production-ready.

