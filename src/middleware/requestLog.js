// Metadata-only request logging — timestamp (implicit, Render stamps every log line), method,
// route, status, latency, request size. Never the request or response body itself, even after
// sanitization; sanitization reduces risk, it doesn't make logging raw payloads a good idea.
// Render captures stdout as its log stream automatically, so plain console.log is enough here —
// no external logging service needed for a single $5/mo instance.
module.exports = function requestLog(req, res, next) {
  const start = Date.now();
  const bodyBytes = req.headers['content-length'] || 0;
  // Captured now, not read inside the `finish` handler: Express's router rewrites req.path as
  // the request descends into a mounted sub-router (e.g. /v1/gemini), and with async route
  // handlers that rewrite is often still in effect by the time `finish` fires later — logging
  // req.originalUrl (which Express never rewrites) instead avoids that giving a misleadingly
  // truncated path in the log line.
  const path = req.originalUrl;
  res.on('finish', () => {
    const ms = Date.now() - start;
    console.log(`[req] ${req.method} ${path} ${res.statusCode} ${ms}ms ${bodyBytes}b`);
  });
  next();
};
