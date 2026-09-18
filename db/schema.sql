-- Plyndi AI Hub — run history + credit ledger (Plyndi-AI-Hub-Design.md §4.6, Phase 3-A).
-- Apply with: node scripts/migrate.js  (every statement is idempotent — CREATE ... IF NOT EXISTS —
-- so re-running this against an already-migrated database on every deploy is a safe no-op).
--
-- Identity is DEVICE-SCOPED, not per-account. Plyndi-AI-Hub-Design.md's original §4.6 assumed a
-- Firebase uid; that assumption is superseded (see the "Identity reality" note added to §10 —
-- there is no Firebase Auth in this app, only on-device Apple/Google sign-in and a client-side
-- `isPremium` boolean). `scope_key` therefore holds whatever src/lib/subject.js resolved: a
-- verified JWT `sub`, `dev:<keychain-uuid>` (Phase 3-B, X-Plyndi-Device-ID), or
-- `anon:<hashed-ip>`. `verified` records which kind, so a future real-account rollout can tell
-- them apart later without a data migration.
--
-- UNVERIFIED IN THIS ENVIRONMENT — see src/lib/store/postgresStore.js's header comment. This file
-- has been reviewed carefully against every query in that module but never actually executed
-- against a live Postgres server (no psql/pg_isready available here, no network path to Render).

CREATE TABLE IF NOT EXISTS ai_runs (
  id UUID PRIMARY KEY,
  scope_key TEXT NOT NULL,
  verified BOOLEAN NOT NULL DEFAULT false,
  capability_id TEXT NOT NULL,
  capability_version INTEGER,
  context_version INTEGER,
  status TEXT NOT NULL,
  result_json JSONB,
  provider TEXT,
  model TEXT,
  latency_ms INTEGER,
  idempotency_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- THIS constraint is the idempotency guarantee (Plyndi-AI-Hub-Design.md §4.3) — src/lib/store/
-- postgresStore.js relies on losing an INSERT to this index and reading back the winning row,
-- never on a read-then-write check in application code, which would have its own race window.
-- Partial (WHERE idempotency_key IS NOT NULL) because not every run carries one, and NULL <>
-- NULL in a unique index anyway so an unkeyed row would never conflict regardless.
CREATE UNIQUE INDEX IF NOT EXISTS ai_runs_scope_idempotency_key
  ON ai_runs (scope_key, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Powers GET /v1/ai/runs (insight feed / history), paginated newest-first per subject.
CREATE INDEX IF NOT EXISTS ai_runs_scope_created_at ON ai_runs (scope_key, created_at DESC);

CREATE TABLE IF NOT EXISTS ai_credit_ledger (
  id UUID PRIMARY KEY,
  scope_key TEXT NOT NULL,
  verified BOOLEAN NOT NULL DEFAULT false,
  run_id UUID REFERENCES ai_runs(id),
  capability_id TEXT NOT NULL,
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT 'run',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Powers GET /v1/ai/entitlement's and POST /v1/ai/run's creditsUsed(subject, periodStart) lookup
-- (the per-subject monthly allowance check).
CREATE INDEX IF NOT EXISTS ai_credit_ledger_scope_created_at ON ai_credit_ledger (scope_key, created_at DESC);
-- Powers globalSpendToday() — the global daily spend cap — deliberately NOT scoped by subject,
-- since the cap sums every subject's spend for the day.
CREATE INDEX IF NOT EXISTS ai_credit_ledger_created_at ON ai_credit_ledger (created_at);

-- Phase 4-A (Plyndi-AI-Hub-Design.md §3.1, §6) — distinguishes "real provider spend" from "counts
-- against a subject's monthly allowance". The Daily Brief is free for every user (creditCost 0 in
-- capabilities/daily_brief.json) but still a real provider call, so its ledger row sets this
-- false: globalSpendToday() (unscoped — see the index comment above) must still see it,
-- creditsUsed(subject, periodStart) must not. Defaults true so every row written before this
-- column existed, and every ordinary POST /v1/ai/run charge after it, is unaffected — this is an
-- ADD COLUMN, not a rebuild of an existing CREATE TABLE IF NOT EXISTS block, specifically so it
-- also lands correctly on an already-migrated live database (re-running this file is Render's
-- Pre-Deploy Command on every deploy).
ALTER TABLE ai_credit_ledger ADD COLUMN IF NOT EXISTS counts_toward_allowance BOOLEAN NOT NULL DEFAULT true;

-- Lightweight registry of every subject the ledger has ever recorded a charge for. `plan` is
-- hardcoded 'unknown' by src/lib/store/postgresStore.js today — there is no server-verifiable
-- Premium signal yet (see src/routes/aiEntitlement.js's header comment). This table exists so a
-- future StoreKit-receipt-verified entitlement phase has somewhere to write a real plan value
-- without a schema change, not because anything reads `plan` from it today.
CREATE TABLE IF NOT EXISTS users_ai (
  scope_key TEXT PRIMARY KEY,
  plan TEXT NOT NULL DEFAULT 'unknown',
  verified BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Phase 4-A (Plyndi-AI-Hub-Design.md §3.1, §4.6) — the Daily Brief cache. ONE row per user per
-- USER-LOCAL day (never UTC — see src/routes/aiBrief.js's header comment for why a UTC-keyed
-- cache would show yesterday's numbers at breakfast in a timezone ahead of UTC). digest_json is
-- written by POST /v1/ai/brief/digest and never triggers generation by itself; brief_text/
-- provider/model are written once, by GET /v1/ai/brief's first call for that day.
--
-- PRIMARY KEY (subject, local_date) IS the once-per-user-per-day guarantee — src/lib/store/
-- postgresStore.js upserts through it (ON CONFLICT), never a read-then-write check, same
-- reasoning as ai_runs' idempotency index above. It also means a second POST for the same day
-- overwrites digest_json but — by construction of that ON CONFLICT clause — can never blank out
-- an already-generated brief_text, so a background digest refresh can never trigger (or cost) a
-- second generation for a day already served.
CREATE TABLE IF NOT EXISTS ai_briefs (
  subject TEXT NOT NULL,
  local_date TEXT NOT NULL,
  digest_json JSONB,
  brief_text TEXT,
  provider TEXT,
  model TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (subject, local_date)
);

-- Retention (Plyndi-AI-Hub-Design.md §4.6): briefs older than ~90 days are prunable. No automatic
-- job runs yet in this phase — same as ai_runs' 12-month retention, documented but not
-- cron-enforced (this repo's anti-goals explicitly rule out adding a cron here). This index is
-- what a future prune job would scan.
CREATE INDEX IF NOT EXISTS ai_briefs_created_at ON ai_briefs (created_at);
