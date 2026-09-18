require('dotenv').config();
const express = require('express');
const rateLimit = require('express-rate-limit');

const requireClientKey = require('./middleware/auth');
const sanitizeBody = require('./middleware/sanitize');
const requestLog = require('./middleware/requestLog');
const appContext = require('./middleware/appContext');

const geminiRoute = require('./routes/gemini');
const openaiRoute = require('./routes/openai');
const generateRoute = require('./routes/generate');
const placesRoute = require('./routes/places');
const syncRoute = require('./routes/sync');
const configRoute = require('./routes/config');
const aiRunRoute = require('./routes/aiRun');
const aiHubRoute = require('./routes/aiHub');
const aiEntitlementRoute = require('./routes/aiEntitlement');
const affiliateRoute = require('../routes/affiliateRoutes');

const app = express();

// Render (and most hosts) sit behind a reverse proxy — needed so express-rate-limit and req.ip
// see the real client IP instead of the proxy's.
app.set('trust proxy', 1);

app.use(express.json({ limit: '1mb' }));
app.use(requestLog);
app.use(appContext);

// No auth or rate limit on the health check — Render's own health monitor hits this, and it
// carries no client key.
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

const limiter = rateLimit({
  windowMs: (Number(process.env.RATE_LIMIT_WINDOW_MINUTES) || 60) * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_MAX) || 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' }
});

app.use(requireClientKey);

// /v1/config is the kill switch itself, so it's mounted here — after the client-key check, but
// ahead of the general-purpose limiter below — with its own, more generous rate limit (see
// routes/config.js). A client must never be able to get itself locked out of finding out that a
// feature has been disabled or an update is required.
app.use('/v1/config', configRoute);

// Everything past this point needs the shared client key (already applied above), is
// rate-limited per IP, and has its request body sanitized — in that order — before any route
// handler (or upstream API) sees it.
app.use(limiter);
app.use(sanitizeBody);

app.use('/v1/gemini', geminiRoute);
app.use('/v1/openai', openaiRoute);
// Provider-agnostic route: the client asks for a profile, the server picks the model.
app.use('/v1/generate', generateRoute);
app.use('/v1/places', placesRoute);
app.use('/v1/sync', syncRoute);
// Capability registry runner (Phase 1-A) — POST /v1/ai/run, GET /v1/ai/runs.
app.use('/v1/ai', aiRunRoute);
// Server-driven hub catalog (Phase 2-A) — GET /v1/ai/hub.
app.use('/v1/ai/hub', aiHubRoute);
// Credits + entitlement reporting (Phase 3-A) — GET /v1/ai/entitlement.
app.use('/v1/ai/entitlement', aiEntitlementRoute);
// Regional affiliate recommendations return all three provider options in one call.
app.use('/api/v1/planner', affiliateRoute);
app.use('/v1/planner', affiliateRoute);

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Deliberately generic — never echoes err.message from an upstream failure back to the client,
// since that could leak upstream response details. Route handlers already log the real error
// server-side themselves before it gets here.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  console.error(`[error] ${req.method} ${req.path}:`, err.message);
  res.status(500).json({ error: 'Something went wrong.' });
});

module.exports = app;

// `require.main === module` is only true when this file is the process entry point (`npm start`,
// `npm run dev`, or Render's own start command) — so listening stays exactly as before for every
// real deployment. When a test script does `require('./server')` instead, it gets the bare `app`
// with nothing listening yet, so it can call `app.listen(0)` itself on an ephemeral port in the
// SAME process. That in-process listen is what lets a test monkey-patch providerGateway.generate
// before making a real HTTP request — no child process, no network, no separate stub protocol.
if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`Plyndi backend listening on port ${port}`);
  });
}
