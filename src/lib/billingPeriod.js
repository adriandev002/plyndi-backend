// Shared UTC time-window math for the Phase 3-A credit ledger (Plyndi-AI-Hub-Design.md §4.6, §6)
// and the global daily spend cap (§4.5, §7). Always wall-clock UTC, never the caller's locale or
// timezone header — a spend cap that rolled over at a different moment for every caller would not
// be a cap at all.

// The current UTC calendar month, as [periodStart, periodEnd) — periodEnd is exclusive (the first
// instant of next month), so "credits used in this period" is a plain `created_at >= periodStart
// AND created_at < periodEnd` range with no off-by-one at the boundary.
function currentBillingPeriod(now = new Date()) {
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
  const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));
  return { periodStart, periodEnd };
}

// Midnight UTC of the current day — the boundary the global spend cap resets on.
function startOfUtcDay(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
}

module.exports = { currentBillingPeriod, startOfUtcDay };
