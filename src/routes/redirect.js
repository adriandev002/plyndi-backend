// ============================================================================
// GET /r/:cardId — Phase 2 click-tracking redirect for affiliate Explore cards, and
// GET /r/banner/:bannerId — the same for Home carousel banners.
// ----------------------------------------------------------------------------
// This is the URL an "affiliate" card's actionURL points at (see src/routes/content.js) —
// exactly what makes the app never see, hardcode, or leak a raw partner deep link. It is opened
// directly in Safari (Explore's `.url` card action calls `openURL`, i.e. the system browser), so
// it MUST NOT require X-Plyndi-Client-Key: Safari has no way to send that header, and mounting
// this ahead of requireClientKey in server.js is what makes that work.
//
// Trip.com's own links are opaque `/t/{code}` short codes with no documented way to append a
// tracked sub-id (see helpers/affiliateHelper.js's header comment on TRIPCOM_AFFILIATE_WRAPPER,
// removed for the same reason) — so unless a provider-specific sub-id parameter is configured for
// THIS card's target, the stored target_url is redirected to completely unchanged. Never attempt
// to construct or guess a provider URL shape here.
// ============================================================================

const express = require('express');
const rateLimit = require('express-rate-limit');

const store = require('../lib/store');

// Separate, tighter ceiling than the general API limiter (src/server.js's `limiter`) — this route
// never even sees that one, since it's mounted ahead of it, same as /v1/config and /v1/ai/hub.
// A generous-but-real cap: enough headroom for a burst of legitimate clicks from one NAT'd
// network, low enough to blunt a scripted hit-every-card-repeatedly abuse pattern.
const redirectLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: Number(process.env.REDIRECT_RATE_LIMIT_MAX) || 120,
  standardHeaders: true,
  legacyHeaders: false,
  // Plain text, not JSON — this response can be shown directly in Safari.
  handler: (_req, res) => res.status(429).type('text/plain').send('Too many requests. Please try again later.'),
});

function readParam(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

// Appends a provider sub-id/tracking query parameter when one is configured for this URL's host,
// so an affiliate provider that DOES support one still gets attributed. Configured as
// "<host-substring>=<paramName>:<value>" pairs, comma-separated, e.g.
// "booking.com=aid:plyndi123,expedia.com=affcid:plyndi456" — intentionally not provider-name
// keyed (unlike helpers/affiliateHelper.js's PROVIDER_CONFIG) since an explore_cards.target_url
// is an arbitrary admin-entered URL, not one of that file's fixed provider list.
function withTrackingParam(targetUrl) {
  const raw = String(process.env.EXPLORE_REDIRECT_SUBID_MAP || '').trim();
  if (!raw) return targetUrl;
  let url;
  try {
    url = new URL(targetUrl);
  } catch (_err) {
    return targetUrl;
  }
  for (const entry of raw.split(',').map((item) => item.trim()).filter(Boolean)) {
    const [hostMatch, paramSpec] = entry.split('=');
    if (!hostMatch || !paramSpec || !url.hostname.includes(hostMatch.trim())) continue;
    const [paramName, paramValue] = paramSpec.split(':');
    if (!paramName || paramValue === undefined) continue;
    url.searchParams.set(paramName.trim(), paramValue.trim());
    return url.toString();
  }
  return targetUrl;
}

const router = express.Router();

// GET /r/banner/:bannerId — the same tracked redirect for a Home carousel banner with a target
// URL (src/routes/content.js's /home-banners). Its own path prefix so a banner and an Explore
// card can share an id: "/r/x" is always the card, "/r/banner/x" always the banner. Express's
// "/:cardId" below only ever matches ONE path segment, so it can never swallow "/banner/x"; an
// Explore card whose id is literally "banner" still resolves at "/r/banner". Registered first
// anyway, so the precedence reads top to bottom. Same limiter, same no-client-key reasoning.
router.get('/banner/:bannerId', redirectLimiter, async (req, res) => {
  const bannerId = readParam(req.params.bannerId);
  if (!bannerId) {
    res.status(404).type('text/plain').send('Not found.');
    return;
  }

  let banner;
  try {
    banner = await store.getHomeBanner(bannerId);
  } catch (err) {
    console.error(`[redirect] GET /r/banner/${bannerId} — store lookup failed: ${err.message}`);
    res.status(404).type('text/plain').send('Not found.');
    return;
  }

  // No banner, or one that opens a screen in the app (or nothing) rather than a URL: never
  // redirect to a guessed URL.
  if (!banner || !banner.targetUrl) {
    res.status(404).type('text/plain').send('Not found.');
    return;
  }

  try {
    await store.recordHomeBannerClick({
      bannerId: banner.id,
      region: readParam(req.query.region),
      appVersion: readParam(req.query.appVersion),
    });
  } catch (err) {
    console.error(`[redirect] GET /r/banner/${bannerId} — recordHomeBannerClick failed (redirecting anyway): ${err.message}`);
  }

  res.redirect(302, withTrackingParam(banner.targetUrl));
});

router.get('/:cardId', redirectLimiter, async (req, res) => {
  const cardId = readParam(req.params.cardId);
  if (!cardId) {
    res.status(404).type('text/plain').send('Not found.');
    return;
  }

  let card;
  try {
    card = await store.getExploreCard(cardId);
  } catch (err) {
    console.error(`[redirect] GET /r/${cardId} — store lookup failed: ${err.message}`);
    res.status(404).type('text/plain').send('Not found.');
    return;
  }

  if (!card || !card.targetUrl) {
    // No card, or a card that exists but was never given a target_url (a firstParty/editorial
    // card has no reason to be linked from /r/ at all) — either way, never redirect to a guessed
    // or invented URL.
    res.status(404).type('text/plain').send('Not found.');
    return;
  }

  // Best-effort: a logging failure must never block the redirect itself.
  try {
    await store.recordExploreClick({
      cardId: card.id,
      region: readParam(req.query.region),
      appVersion: readParam(req.query.appVersion),
    });
  } catch (err) {
    console.error(`[redirect] GET /r/${cardId} — recordExploreClick failed (redirecting anyway): ${err.message}`);
  }

  res.redirect(302, withTrackingParam(card.targetUrl));
});

module.exports = router;
