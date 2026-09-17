// Parses the app's version/platform headers onto req.appContext. Mounted globally (every
// request gets an appContext, even ones that never read it) so /v1/config doesn't need special
// wiring to see it.
//
// Missing or malformed headers must NOT reject the request — this feeds the version gate in
// routes/config.js, which fails open on anything it can't parse. A build that forgets to send
// X-Plyndi-App-Version (or sends garbage) must be treated as "unknown version", never as an
// error response.
module.exports = function appContext(req, _res, next) {
  const versionHeader = req.get('X-Plyndi-App-Version');
  const platformHeader = req.get('X-Plyndi-Platform');

  const appVersion = typeof versionHeader === 'string' && versionHeader.trim() ? versionHeader.trim() : null;
  const platform = typeof platformHeader === 'string' && platformHeader.trim() ? platformHeader.trim() : 'unknown';

  req.appContext = { appVersion, platform };
  next();
};
