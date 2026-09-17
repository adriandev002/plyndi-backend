// Minimal numeric semver comparator — deliberately NOT a string comparison. Comparing version
// strings lexically gives "1.10.0" < "1.9.0" (because "1" < "9" as characters), which would tell
// the newest users on the fleet to update — the exact opposite of what a version gate is for.
// Each segment is parsed to a number and compared numerically instead.
function parseVersion(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  // Accepts "1", "1.0" and "1.0.0". The app's MARKETING_VERSION is currently "1.0",
  // and an X.Y.Z-only pattern makes every comparison null — which fails open and
  // silently disables the version gate entirely.
  const match = trimmed.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)];
}

// Returns -1 / 0 / 1 the usual way, or `null` when either side can't be parsed as X.Y.Z — the
// caller decides what "unknown" should mean (for the version gate, it means "don't require an
// update", i.e. fail open — see routes/config.js).
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

module.exports = { compareVersions, parseVersion };
