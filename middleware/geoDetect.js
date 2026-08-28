const REGION_COUNTRIES = {
  ASIA: new Set(['CN', 'HK', 'ID', 'IN', 'JP', 'KH', 'KR', 'LA', 'MY', 'MM', 'MN', 'MO', 'NP', 'PH', 'SG', 'LK', 'TH', 'TW', 'VN']),
  US: new Set(['US', 'CA', 'MX']),
  EU: new Set(['AT', 'BE', 'BG', 'CH', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GB', 'GR', 'HR', 'HU', 'IE', 'IS', 'IT', 'LI', 'LT', 'LU', 'LV', 'MT', 'NL', 'NO', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK']),
  AU: new Set(['AU', 'NZ', 'FJ'])
};

const REGION_IP_PREFIXES = {
  ASIA: ['1.0.', '14.', '27.', '36.', '42.', '49.', '58.', '61.'],
  US: ['3.', '4.', '8.', '12.', '13.', '18.', '20.', '23.', '24.', '32.', '34.', '35.', '44.', '47.', '50.', '52.', '54.', '63.', '64.', '66.', '67.', '68.', '69.', '70.', '71.', '72.', '73.', '74.', '75.', '76.', '96.', '98.', '99.', '104.', '107.', '108.', '128.', '129.', '130.', '131.', '132.', '134.', '136.', '137.', '138.', '139.', '140.', '141.', '142.', '143.', '144.', '146.', '147.', '148.', '149.', '150.', '152.', '155.', '156.', '157.', '158.', '159.', '160.', '161.', '162.', '163.', '164.', '165.', '166.', '167.', '168.', '169.', '170.', '172.', '173.', '174.', '184.', '192.', '198.', '199.', '200.', '204.', '205.', '206.', '207.', '208.', '209.', '216.'],
  EU: ['2.', '5.', '31.', '37.', '46.', '51.', '62.', '77.', '78.', '80.', '81.', '82.', '83.', '84.', '85.', '86.', '87.', '88.', '89.', '90.', '91.', '92.', '93.', '109.', '176.', '178.', '185.', '188.', '193.', '194.', '195.', '212.', '213.', '217.'],
  AU: ['110.', '111.', '112.', '113.', '114.', '115.', '116.', '117.', '118.', '119.', '120.', '121.', '122.', '123.', '124.', '125.', '139.', '180.', '202.', '203.']
};

function firstForwardedIp(value) {
  return String(value || '').split(',')[0].trim().replace(/^::ffff:/i, '');
}

function regionFromCountry(countryCode) {
  const country = String(countryCode || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) return null;
  for (const [region, countries] of Object.entries(REGION_COUNTRIES)) {
    if (countries.has(country)) return region;
  }
  return null;
}

function detectRegion(req) {
  const ip = firstForwardedIp(req.get('x-forwarded-for') || req.ip);
  const country = req.get('cf-ipcountry') || req.get('x-vercel-ip-country') || req.get('x-country-code');
  const countryRegion = regionFromCountry(country);
  if (countryRegion) return { region: countryRegion, country: String(country).toUpperCase(), ip, source: 'trusted-country-header' };

  for (const entry of String(process.env.GEOIP_REGION_MAP || '').split(',').map((item) => item.trim()).filter(Boolean)) {
    const [prefix, region] = entry.split(':').map((value) => value && value.trim().toUpperCase());
    if (prefix && region && ip.startsWith(prefix) && REGION_COUNTRIES[region]) {
      return { region, country: null, ip, source: 'configured-ip-prefix' };
    }
  }
  for (const [region, prefixes] of Object.entries(REGION_IP_PREFIXES)) {
    if (prefixes.some((prefix) => ip.startsWith(prefix))) return { region, country: null, ip, source: 'coarse-ip-prefix' };
  }
  const fallback = String(process.env.DEFAULT_REGION || 'US').toUpperCase();
  return { region: REGION_COUNTRIES[fallback] ? fallback : 'US', country: null, ip, source: 'default' };
}

module.exports = function geoDetect(req, _res, next) {
  req.geo = detectRegion(req);
  next();
};
module.exports.detectRegion = detectRegion;
module.exports.regionFromCountry = regionFromCountry;
