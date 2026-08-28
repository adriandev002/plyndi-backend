const PROVIDER_CONFIG = {
  'Trip.com': { flight: 'https://www.trip.com/flights', hotel: 'https://www.trip.com/hotels', env: 'TRIPCOM_AFFILIATE_WRAPPER' },
  Agoda: { flight: 'https://www.agoda.com/flights', hotel: 'https://www.agoda.com/search', env: 'AGODA_AFFILIATE_WRAPPER' },
  'Booking.com': { flight: 'https://www.booking.com/flights', hotel: 'https://www.booking.com/searchresults.html', env: 'BOOKING_AFFILIATE_WRAPPER' },
  Expedia: { flight: 'https://www.expedia.com/Flights-Search', hotel: 'https://www.expedia.com/Hotel-Search', env: 'EXPEDIA_AFFILIATE_WRAPPER' },
  Skyscanner: { flight: 'https://www.skyscanner.com/transport/flights', hotel: 'https://www.skyscanner.com/hotels', env: 'SKYSCANNER_AFFILIATE_WRAPPER' },
  Priceline: { flight: 'https://www.priceline.com/m/fly', hotel: 'https://www.priceline.com/stay', env: 'PRICELINE_AFFILIATE_WRAPPER' },
  Webjet: { flight: 'https://www.webjet.com.au/flights', hotel: 'https://www.webjet.com.au/hotels', env: 'WEBJET_AFFILIATE_WRAPPER' }
};

function addQuery(url, params) {
  const target = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') target.searchParams.set(key, value);
  }
  return target.toString();
}

/**
 * Travelpayouts credentials stay server-side. The marker is used to build the
 * public redirect URL; the API key is reserved for optional live data adapters.
 */
function getTravelpayoutsConfig() {
  return {
    marker: String(process.env.TRAVELPAYOUTS_MARKER || '').trim(),
    apiKey: String(process.env.TRAVELPAYOUTS_API_KEY || '').trim(),
    flightDataApiUrl: String(process.env.TRAVELPAYOUTS_FLIGHT_DATA_API_URL || '').trim()
  };
}

function isTravelpayoutsConfigured() {
  const { marker, apiKey } = getTravelpayoutsConfig();
  return Boolean(marker && apiKey);
}

/**
 * Travelpayouts deep-link wrapper:
 * https://tp.media/r?p={marker}&url={encodedDestinationUrl}
 */
function wrapWithTravelpayouts(destinationUrl) {
  const { marker } = getTravelpayoutsConfig();
  if (!marker) return destinationUrl;
  return `https://tp.media/r?p=${encodeURIComponent(marker)}&url=${encodeURIComponent(destinationUrl)}`;
}

function applyTemplate(wrapper, values) {
  return wrapper
    .replaceAll('{url}', encodeURIComponent(values.url))
    .replaceAll('{provider}', encodeURIComponent(values.provider))
    .replaceAll('{subId}', encodeURIComponent(values.subId))
    .replaceAll('{origin}', encodeURIComponent(values.origin || ''))
    .replaceAll('{destination}', encodeURIComponent(values.destination || ''))
    .replaceAll('{dates}', encodeURIComponent(values.dates || ''));
}

function buildProviderUrl(provider, category, params = {}) {
  const config = PROVIDER_CONFIG[provider];
  if (!config) throw new Error(`Unsupported affiliate provider: ${provider}`);
  if (!['flight', 'hotel'].includes(category)) throw new Error(`Unsupported affiliate category: ${category}`);

  const direct = addQuery(category === 'hotel' ? config.hotel : config.flight, category === 'hotel'
    ? { destination: params.destination, checkIn: params.dates, checkOut: params.checkout }
    : { origin: params.origin, destination: params.destination, dates: params.dates });

  const values = {
    url: direct,
    provider,
    subId: `plyndi_${category}`,
    origin: params.origin,
    destination: params.destination,
    dates: params.dates
  };

  // A provider-specific wrapper takes precedence when one is configured.
  const providerWrapper = String(process.env[config.env] || '').trim();
  if (providerWrapper) return applyTemplate(providerWrapper, values);

  // A Travelpayouts marker provides the requested tracked redirect for every
  // provider. If it is unavailable, return a safe direct link instead.
  const travelpayoutsUrl = wrapWithTravelpayouts(direct);
  if (travelpayoutsUrl !== direct) return travelpayoutsUrl;

  const genericWrapper = String(process.env.TRAVELPAYOUTS_DEEPLINK_WRAPPER || process.env.IMPACT_DEEPLINK_WRAPPER || '').trim();
  return genericWrapper ? applyTemplate(genericWrapper, values) : direct;
}

function generateAffiliateLink(provider, category, params) {
  return buildProviderUrl(provider, category, params);
}

/**
 * Optional live Flight Data API configuration. The recommendation controller
 * can use this when a provider-specific endpoint is configured; otherwise its
 * existing indicative mock data remains the graceful fallback.
 */
function getTravelpayoutsApiRequestConfig() {
  const { apiKey, flightDataApiUrl } = getTravelpayoutsConfig();
  if (!apiKey || !flightDataApiUrl) return null;
  return {
    url: flightDataApiUrl,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`
    }
  };
}

module.exports = {
  PROVIDER_CONFIG,
  addQuery,
  getTravelpayoutsConfig,
  isTravelpayoutsConfigured,
  getTravelpayoutsApiRequestConfig,
  wrapWithTravelpayouts,
  buildProviderUrl,
  generateAffiliateLink
};
