const { generateAffiliateLink } = require('../helpers/affiliateHelper');

const PROVIDERS_BY_REGION = {
  ASIA: ['Trip.com', 'Agoda', 'Booking.com'],
  US: ['Expedia', 'Booking.com', 'Priceline'],
  EU: ['Booking.com', 'Expedia', 'Skyscanner'],
  AU: ['Webjet', 'Booking.com', 'Skyscanner']
};

const CURRENCY_BY_REGION = { ASIA: 'USD', US: 'USD', EU: 'EUR', AU: 'AUD' };
const PROVIDER_PRICE_MULTIPLIER = { 'Trip.com': 0.92, Agoda: 0.95, 'Booking.com': 1, Expedia: 0.97, Skyscanner: 0.94, Priceline: 0.96, Webjet: 0.93 };

function clean(value, max = 120) {
  return String(value || '').trim().replace(/[<>]/g, '').slice(0, max);
}

function parseDates(value) {
  const dates = clean(value, 80);
  if (!dates) return { raw: '', start: '', end: '' };
  const parts = dates.split(/\s*(?:to|–|—|,)\s*/i);
  return { raw: dates, start: parts[0] || '', end: parts[1] || '' };
}

function basePrice(category, origin, destination) {
  const routeDistance = Math.max(1, origin.length + destination.length);
  return category === 'hotel' ? 95 + routeDistance * 3 : 180 + routeDistance * 11;
}

function createRecommendation(provider, category, params, index) {
  const price = Math.round(basePrice(category, params.origin, params.destination) * (PROVIDER_PRICE_MULTIPLIER[provider] || 1) + index * 7);
  const isBest = index === 0;
  return {
    provider,
    price,
    currency: params.currency,
    priceLabel: `from ${new Intl.NumberFormat('en-US', { style: 'currency', currency: params.currency, maximumFractionDigits: 0 }).format(price)}`,
    badge: isBest ? 'BEST DEAL' : index === 1 ? 'TOP PICK 4.8★' : 'POPULAR',
    rating: index === 1 ? 4.8 : index === 0 ? 4.7 : 4.5,
    title: category === 'hotel' ? `${params.destination} hotel stays` : `${params.origin} → ${params.destination}`,
    subtitle: category === 'hotel' ? `Flexible stays near ${params.destination}` : `Flexible fares for ${params.dates || 'your selected dates'}`,
    isEstimated: true,
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
  const recommendations = providers.map((provider, index) => createRecommendation(provider, category, params, index));

  return res.json({
    version: '1.0',
    category,
    query: { origin, destination, dates: dates.raw },
    region: { code: region, country: req.geo?.country || null, detectionSource: req.geo?.source || 'default' },
    currency: params.currency,
    providers,
    recommendations,
    generatedAt: new Date().toISOString(),
    pricingNote: 'Prices are indicative estimates. Final availability, taxes, and prices are shown by the provider.'
  });
}

module.exports = { getAffiliateRecommendations, PROVIDERS_BY_REGION };
