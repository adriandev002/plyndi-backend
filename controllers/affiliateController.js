const { generateAffiliateLink } = require('../helpers/affiliateHelper');

const PROVIDERS_BY_REGION = {
  ASIA: ['Trip.com', 'Agoda', 'Booking.com'],
  US: ['Expedia', 'Booking.com', 'Priceline'],
  EU: ['Booking.com', 'Expedia', 'Skyscanner'],
  AU: ['Webjet', 'Booking.com', 'Skyscanner']
};

const CURRENCY_BY_REGION = { ASIA: 'USD', US: 'USD', EU: 'EUR', AU: 'AUD' };

// ============================================================================
// NO PRICES, NO RATINGS, NO BADGES. Read this before adding a field.
// ----------------------------------------------------------------------------
// Until 21 Sep 2026 this file computed a "price" from `origin.length +
// destination.length` multiplied by a per-provider constant, and returned it as
// `priceLabel: "from US$412"` alongside `badge: "BEST DEAL"` and `rating: 4.8`.
// Those numbers were invented. Presenting invented prices and ratings as offers
// is an App Review 2.3 (Accurate Metadata) rejection and a consumer-protection
// problem in TW and the EU.
//
// This endpoint may only return: the provider name, a neutral title/subtitle,
// and a deep link. Any price, rating, badge, discount or availability claim has
// to come from a provider API response. We do not have such an API. If one is
// added later, pass its values through verbatim and cite the source field —
// never derive, estimate, round or embellish them here.
// ============================================================================

function clean(value, max = 120) {
  return String(value || '').trim().replace(/[<>]/g, '').slice(0, max);
}

function parseDates(value) {
  const dates = clean(value, 80);
  if (!dates) return { raw: '', start: '', end: '' };
  const parts = dates.split(/\s*(?:to|–|—|,)\s*/i);
  return { raw: dates, start: parts[0] || '', end: parts[1] || '' };
}

function createRecommendation(provider, category, params) {
  return {
    provider,
    title: category === 'hotel' ? `${params.destination} hotel stays` : `${params.origin} → ${params.destination}`,
    subtitle: category === 'hotel'
      ? `Search stays in ${params.destination} on ${provider}`
      : `Search fares for ${params.dates || 'your selected dates'} on ${provider}`,
    affiliateUrl: generateAffiliateLink(provider, category, params)
  };
}

function getAffiliateRecommendations(req, res) {
  const origin = clean(req.query.origin);
  const destination = clean(req.query.destination);
  const dates = parseDates(req.query.dates);
  const category = clean(req.query.category || 'flight').toLowerCase();
  if (!destination || (category === 'flight' && !origin)) return res.status(400).json({ error: 'origin and destination are required for flight recommendations.' });
  if (!['flight', 'hotel'].includes(category)) return res.status(400).json({ error: 'category must be flight or hotel.' });

  const region = req.geo?.region || 'US';
  const providers = PROVIDERS_BY_REGION[region] || PROVIDERS_BY_REGION.US;
  const params = { origin, destination, dates: dates.raw, checkout: dates.end, currency: CURRENCY_BY_REGION[region] };
  const recommendations = providers.map((provider) => createRecommendation(provider, category, params));

  return res.json({
    version: '1.0',
    category,
    query: { origin, destination, dates: dates.raw },
    region: { code: region, country: req.geo?.country || null, detectionSource: req.geo?.source || 'default' },
    currency: params.currency,
    providers,
    recommendations,
    generatedAt: new Date().toISOString(),
    pricingNote: 'Plyndi does not quote prices. Availability, taxes and prices are shown by the provider after you follow the link.'
  });
}

module.exports = { getAffiliateRecommendations, PROVIDERS_BY_REGION };
