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

-- ============================================================================
-- Explore feed (Phase 2 — GET /v1/content/explore, GET /r/:cardId, /v1/admin/explore-cards).
-- Three new CREATE TABLE IF NOT EXISTS blocks, additive only, same rule as every block above:
-- never edit or rebuild ai_runs/ai_credit_ledger/users_ai/ai_briefs to add these.
--
-- NO price, rating, badge or discount column anywhere below, on purpose. Read
-- controllers/affiliateController.js's header comment: Phase 0 deleted invented pricing from the
-- affiliate recommendations endpoint because presenting invented numbers as offers is an App
-- Review 2.3 rejection and a consumer-protection problem in TW and the EU. Leaving those columns
-- out of this schema is what stops them coming back through this feed instead.
-- ============================================================================

CREATE TABLE IF NOT EXISTS explore_cards (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('editorial', 'affiliate', 'firstParty')),
  category TEXT NOT NULL CHECK (category IN ('travel', 'hotels', 'lifestyle')),
  image_url TEXT,
  image_height INTEGER NOT NULL DEFAULT 160,
  icon TEXT NOT NULL,
  target_url TEXT,
  navigate_to TEXT,
  min_app_version TEXT NOT NULL DEFAULT '0.0.0',
  -- NULL means "every region" — never an empty array, which would instead mean "no region at
  -- all", i.e. a card nothing could ever match. GET /v1/content/explore's region filter treats
  -- NULL and only NULL as the everywhere case (see src/routes/content.js).
  regions TEXT[],
  weight INTEGER NOT NULL DEFAULT 0,
  published BOOLEAN NOT NULL DEFAULT false,
  publish_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Powers GET /v1/content/explore's listing query (published + in-window rows, newest-weight
-- first); region and min_app_version filtering happen in application code afterward (same
-- "SQL narrows, application code decides eligibility" split src/lib/store/postgresStore.js
-- already uses for compareVersions elsewhere), so this index isn't a covering index — just
-- enough to avoid a full table scan on the common case.
CREATE INDEX IF NOT EXISTS explore_cards_published_weight ON explore_cards (published, weight DESC, created_at DESC);

-- One row per (card, locale). ON DELETE CASCADE so DELETE /v1/admin/explore-cards/:id can never
-- leave orphaned text rows behind.
CREATE TABLE IF NOT EXISTS explore_card_text (
  card_id TEXT NOT NULL REFERENCES explore_cards(id) ON DELETE CASCADE,
  locale TEXT NOT NULL,
  tag TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  cta_label TEXT NOT NULL,
  PRIMARY KEY (card_id, locale)
);

-- Click-through log for GET /r/:cardId. Deliberately NOT a foreign key to explore_cards — a card
-- can be deleted from the admin API later and its click history must survive that for reporting,
-- the same reasoning ai_credit_ledger.run_id above is a plain reference, not a cascading one.
CREATE TABLE IF NOT EXISTS explore_clicks (
  id BIGSERIAL PRIMARY KEY,
  card_id TEXT NOT NULL,
  clicked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  region TEXT,
  app_version TEXT
);

-- Powers GET /v1/admin/explore-clicks' exploreClickCounts(since) lookup.
CREATE INDEX IF NOT EXISTS explore_clicks_card_clicked_at ON explore_clicks (card_id, clicked_at);

-- ============================================================================
-- Home banner carousel — GET /v1/content/home-banners, POST /v1/content/home-banners/impressions,
-- GET /r/banner/:id, /v1/admin/home-banners, /v1/admin/home-banner-stats. Four new
-- CREATE TABLE IF NOT EXISTS blocks, additive only, same rule as every block above: nothing above
-- is edited or rebuilt to add these.
--
-- Same shape as the Explore tables on purpose (a row table, a per-locale table, a click log),
-- with the column names the banner brief asked for where it named them (position, active,
-- starts_at, ends_at, image_has_text, text_theme, …) and explore_cards' names everywhere else
-- (image_url, target_url, navigate_to, min_app_version, cta_label).
--
-- NO price, rating, badge, discount or "deal" column, for the same reason as explore_cards above.
-- A sponsored banner carries its partner's NAME (partner_name) so the app can disclose it; it
-- never carries an offer.
-- ============================================================================

CREATE TABLE IF NOT EXISTS home_banners (
  id TEXT PRIMARY KEY,
  -- Named so a later phase can widen it with DROP CONSTRAINT / ADD CONSTRAINT instead of a rebuild.
  type TEXT NOT NULL CONSTRAINT home_banners_type_check CHECK (type IN ('firstParty', 'affiliate')),
  -- Required for affiliate (src/routes/admin.js); shown by the app as the sponsor.
  partner_name TEXT,
  -- Carousel order, ascending. Not unique: ties break on created_at, so a reorder never has to
  -- juggle a uniqueness constraint mid-update.
  position INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT false,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  -- NULL means every app version (the brief asked for it nullable; explore_cards uses '0.0.0').
  min_app_version TEXT,
  -- The default image. A locale may override it (home_banner_text.image_url), and only when
  -- image_has_text is true — an image with words drawn in needs one per language.
  image_url TEXT NOT NULL,
  image_has_text BOOLEAN NOT NULL DEFAULT false,
  -- light = white text on a dark gradient scrim; dark = dark text on a light scrim.
  text_theme TEXT NOT NULL DEFAULT 'light' CONSTRAINT home_banners_text_theme_check CHECK (text_theme IN ('light', 'dark')),
  target_url TEXT,
  navigate_to TEXT,
  -- Hotel and flight partners: the app shows the banner only to users with a trip planned. The
  -- server cannot know that, so it passes the flag and the app filters.
  requires_upcoming_trip BOOLEAN NOT NULL DEFAULT false,
  -- NULL means every app language — never an empty array, which would mean no language at all.
  locales TEXT[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A banner opens a URL, a screen in the app, or nothing — never both. admin.js enforces this
  -- with a readable 400 first; this is the backstop for any other writer.
  CONSTRAINT home_banners_one_action CHECK (target_url IS NULL OR navigate_to IS NULL)
);

-- Powers GET /v1/content/home-banners' listing query (active rows in position order).
CREATE INDEX IF NOT EXISTS home_banners_active_position ON home_banners (active, position, created_at);

-- One row per (banner, locale). "en" is required by the admin API and is the fallback for every
-- other locale. Length limits (title 40, subtitle 80, cta 20, alt 1-120) are enforced in
-- src/routes/admin.js, where a failure can be a readable 400, same as explore_card_text.
CREATE TABLE IF NOT EXISTS home_banner_text (
  banner_id TEXT NOT NULL REFERENCES home_banners(id) ON DELETE CASCADE,
  locale TEXT NOT NULL,
  title TEXT,
  subtitle TEXT,
  cta_label TEXT,
  alt_text TEXT NOT NULL,
  image_url TEXT,
  PRIMARY KEY (banner_id, locale)
);

-- Click-through log for GET /r/banner/:id. A separate table rather than a `kind` column on
-- explore_clicks: every explore_clicks query stays exactly as it is (a kind column would have
-- meant editing exploreClickCounts too, or banner taps would silently count as Explore clicks),
-- and a banner and an Explore card may share an id without their counts ever mixing. Not a
-- foreign key, for the same reason explore_clicks isn't: history outlives the banner.
CREATE TABLE IF NOT EXISTS home_banner_clicks (
  id BIGSERIAL PRIMARY KEY,
  banner_id TEXT NOT NULL,
  clicked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  region TEXT,
  app_version TEXT
);

CREATE INDEX IF NOT EXISTS home_banner_clicks_banner_clicked_at ON home_banner_clicks (banner_id, clicked_at);

-- Aggregated daily impression counts (UTC days), written by POST /v1/content/home-banners/impressions.
-- Counts only: no user id, device id, IP or anything else that identifies who saw a banner.
-- Not a foreign key, like home_banner_clicks, so stats outlive a deleted banner.
CREATE TABLE IF NOT EXISTS home_banner_impressions (
  banner_id TEXT NOT NULL,
  day DATE NOT NULL,
  impressions BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (banner_id, day)
);
