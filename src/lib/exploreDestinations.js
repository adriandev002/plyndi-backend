// ============================================================================
// The `navigate_to` contract between this service and the iOS/Android clients.
// ----------------------------------------------------------------------------
// A `firstParty` explore card carries `navigateTo` instead of a URL, and the app resolves it to
// one of its own screens. Nothing in JavaScript or SQL can type-check that string, so it is
// validated HERE, at write time, against the destinations the app actually has.
//
// Why this exists: the original seed shipped `navigateTo: "travelPlanner"`, which matches no
// case in the app's `AppDestination` / `AppSection` enums. The client's contract is to DROP a
// card whose destination it cannot parse — so that card would have silently disappeared from
// Explore the moment remote content went live, with no error on either side. A bad destination
// has to be a 400 when it is written, not a missing card when it is read.
//
// Keep in sync with the iOS app:
//   AppDestination (Plyndi/MainTabView.swift) = .section(AppSection) | .aiHub
//   AppSection     (Plyndi/AppShell.swift)    = home, wallet, shopping, todo, fitness, travel,
//                                               calendar, notes, focus, reminders, settings
// Adding a destination here before the app understands it ships a card older builds will drop;
// that is what `minAppVersion` on the card is for.
// ============================================================================

const APP_SECTIONS = Object.freeze([
  'home', 'wallet', 'shopping', 'todo', 'fitness', 'travel',
  'calendar', 'notes', 'focus', 'reminders', 'settings',
]);

/// Every destination string a card may carry: "aiHub", or "section.<case>".
const NAVIGATE_DESTINATIONS = Object.freeze(
  new Set(['aiHub', ...APP_SECTIONS.map((section) => `section.${section}`)])
);

function isValidNavigateTo(value) {
  return typeof value === 'string' && NAVIGATE_DESTINATIONS.has(value);
}

module.exports = { APP_SECTIONS, NAVIGATE_DESTINATIONS, isValidNavigateTo };
