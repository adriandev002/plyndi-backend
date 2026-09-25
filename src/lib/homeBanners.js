// ============================================================================
// Home banner carousel rules shared by src/routes/content.js (the public feed) and
// src/routes/admin.js (validation, warnings, and the settings the admin page previews against).
// ----------------------------------------------------------------------------
// The env settings are read on every call, not once at boot, so a change on Render takes effect
// on the next request without an app release — the reason they are env vars at all. Same "read
// fresh" convention requireAdminToken already uses for ADMIN_TOKEN.
// ============================================================================

// The carousel shows at most this many banners, and the admin API refuses to activate more.
const MAX_ACTIVE_BANNERS = 10;

// Text limits, in characters as a person counts them (grapheme clusters — see charCount).
const LIMITS = Object.freeze({
  title: 40,
  subtitle: 80,
  ctaLabel: 20,
  altText: 120,
  partnerName: 60,
});

const DEFAULT_INTERVAL_SECONDS = 4;
const MIN_INTERVAL_SECONDS = 3;
const MAX_INTERVAL_SECONDS = 10;
const DEFAULT_ASPECT_RATIO = 3.0; // 1200x400
const DEFAULT_IMAGE_HOSTS = ['cdn.plyndi.com', 'plyndi.com', 'www.plyndi.com'];

// More active affiliate banners than this and the carousel reads as an ad slot.
const MAX_ACTIVE_AFFILIATE_BEFORE_WARNING = 2;

/// HOME_BANNER_INTERVAL_SECONDS, clamped to 3–10. Missing or not a number -> 4.
function intervalSeconds() {
  const raw = Number(process.env.HOME_BANNER_INTERVAL_SECONDS);
  if (!process.env.HOME_BANNER_INTERVAL_SECONDS || !Number.isFinite(raw)) return DEFAULT_INTERVAL_SECONDS;
  return Math.min(MAX_INTERVAL_SECONDS, Math.max(MIN_INTERVAL_SECONDS, raw));
}

/// HOME_BANNER_ASPECT_RATIO (width / height). Missing, not a number, or not positive -> 3.0.
function aspectRatio() {
  const raw = Number(process.env.HOME_BANNER_ASPECT_RATIO);
  if (!process.env.HOME_BANNER_ASPECT_RATIO || !Number.isFinite(raw) || raw <= 0) return DEFAULT_ASPECT_RATIO;
  return raw;
}

/// BANNER_IMAGE_HOSTS, comma-separated, lowercased. Hosts match EXACTLY — "plyndi.com" does not
/// admit "evil-plyndi.com" or "plyndi.com.evil.net". Empty or unset -> the defaults.
function imageHosts() {
  const configured = String(process.env.BANNER_IMAGE_HOSTS || '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  return configured.length ? configured : [...DEFAULT_IMAGE_HOSTS];
}

// Characters as a reader counts them. Code points would count a Burmese or Thai syllable with its
// combining marks as several characters, and UTF-16 units would count an emoji as two — both
// would make the limits bite far earlier than the text actually looks long.
const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
function charCount(value) {
  if (typeof value !== 'string') return 0;
  if (segmenter) {
    let n = 0;
    // eslint-disable-next-line no-unused-vars
    for (const _ of segmenter.segment(value)) n += 1;
    return n;
  }
  return [...value].length;
}

// Carousel order: position ascending, then oldest first, then id — a total order, so a reload
// never reshuffles two banners that share a position.
function byPosition(a, b) {
  return (a.position - b.position)
    || ((a.createdAtMs || 0) - (b.createdAtMs || 0))
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/// Advisory warnings about the set of banners as a whole. Never block a save.
function warningsFor(banners) {
  const active = banners.filter((banner) => banner.active).sort(byPosition);
  const warnings = [];
  const affiliates = active.filter((banner) => banner.type === 'affiliate');
  if (affiliates.length > MAX_ACTIVE_AFFILIATE_BEFORE_WARNING) {
    warnings.push(`${affiliates.length} affiliate banners are active. More than ${MAX_ACTIVE_AFFILIATE_BEFORE_WARNING} makes the carousel read as an ad slot.`);
  }
  if (active.length && active[0].type === 'affiliate' && !active.some((banner) => banner.type === 'firstParty')) {
    warnings.push(`An affiliate banner ("${active[0].id}") is first in the carousel and no first-party banner is active.`);
  }
  return warnings;
}

/// Today's UTC date as YYYY-MM-DD — the `day` impressions are aggregated under.
function utcDay(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

module.exports = {
  MAX_ACTIVE_BANNERS,
  LIMITS,
  DEFAULT_INTERVAL_SECONDS,
  DEFAULT_ASPECT_RATIO,
  DEFAULT_IMAGE_HOSTS,
  intervalSeconds,
  aspectRatio,
  imageHosts,
  charCount,
  byPosition,
  warningsFor,
  utcDay,
};
