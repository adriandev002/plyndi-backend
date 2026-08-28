require('dotenv').config();
const express = require('express');
const rateLimit = require('express-rate-limit');

const requireClientKey = require('./middleware/auth');
const sanitizeBody = require('./middleware/sanitize');
const requestLog = require('./middleware/requestLog');

const geminiRoute = require('./routes/gemini');
const openaiRoute = require('./routes/openai');
const placesRoute = require('./routes/places');
const syncRoute = require('./routes/sync');
const affiliateRoute = require('../routes/affiliateRoutes');

const app = express();

// Render (and most hosts) sit behind a reverse proxy — needed so express-rate-limit and req.ip
// see the real client IP instead of the proxy's.
app.set('trust proxy', 1);

app.use(express.json({ limit: '1mb' }));
app.use(requestLog);

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

// Everything past this point needs the shared client key, is rate-limited per IP, and has its
// request body sanitized — in that order — before any route handler (or upstream API) sees it.
app.use(requireClientKey);
app.use(limiter);
app.use(sanitizeBody);

app.use('/v1/gemini', geminiRoute);
app.use('/v1/openai', openaiRoute);
app.use('/v1/places', placesRoute);
app.use('/v1/sync', syncRoute);
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

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Plyndi backend listening on port ${port}`);
});
