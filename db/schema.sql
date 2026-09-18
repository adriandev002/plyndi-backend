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
