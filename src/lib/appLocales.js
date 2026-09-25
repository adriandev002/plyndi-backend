// ============================================================================
// The app's language codes — the values the iOS app sends as ?locale=.
// ----------------------------------------------------------------------------
// Keep in sync with the iOS app: AIHubCatalog.localeCode(for:) (Plyndi/AIHubCatalog.swift) maps
// each app language to exactly these twelve codes, and it is what ExploreContentService.swift
// sends as `locale`. A banner restricted to a code that is not on this list could never be shown,
// so src/routes/admin.js validates `locales` (and home_banner_text's locales) against it at write
// time — same reasoning as exploreDestinations.js for navigate_to.
// ============================================================================

const APP_LOCALES = Object.freeze([
  'en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'my', 'th', 'vi', 'ar', 'es', 'de', 'fr',
]);

const APP_LOCALE_SET = Object.freeze(new Set(APP_LOCALES));

function isAppLocale(value) {
  return typeof value === 'string' && APP_LOCALE_SET.has(value);
}

module.exports = { APP_LOCALES, isAppLocale };
