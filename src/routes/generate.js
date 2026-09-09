// ============================================================================
// POST /v1/generate — provider-agnostic AI generation.
// ----------------------------------------------------------------------------
// The client sends WHAT it wants ("a rich JSON answer to this prompt"), never
// WHO should answer it. Which model serves a profile is decided here, from
// environment variables, so swapping or retiring a model is a Render env change
// and a redeploy — not an App Store release that users must install.
//
//   POST /v1/generate
//   { profile, schemaVersion, system, user, jsonSchema?, maxOutputTokens?, temperature? }
//   → { text, provider, model, latencyMs, attempts }
//
// Auth, rate limiting, body parsing and sanitising are already applied globally
// in src/server.js before this router is reached — deliberately not repeated here.
// ============================================================================

const express = require('express');
const router = express.Router();

// ---------------------------------------------------------------------------
// Model chains, in preference order: "provider:model,provider:model".
// Pin STABLE model ids. Never a `-latest` alias — Google hot-swaps those on
// every release, which silently changes token behaviour underneath you.
// ---------------------------------------------------------------------------

const DEFAULT_CHAINS = {
  fast: 'openai:gpt-4o-mini,gemini:gemini-3.6-flash',
  // Measured Sep 2026 on a real one-day Osaka itinerary: gpt-4o-mini with strict
  // structured outputs ~6.7s, gemini-3.6-flash ~18s (and 30s+ on a bad run), for
  // identical output shape. Gemini stays second as the automatic fallback.
  rich: 'openai:gpt-4o-mini,gemini:gemini-3.6-flash',
};

const MIN_SCHEMA_VERSION = Number(process.env.MIN_SCHEMA_VERSION || 1);
const PER_ATTEMPT_TIMEOUT_MS = Number(process.env.PROVIDER_TIMEOUT_MS || 30000);
const REQUEST_DEADLINE_MS = Number(process.env.REQUEST_DEADLINE_MS || 45000);

function chainFor(profile) {
  const raw = process.env[`MODELS_${String(profile).toUpperCase()}`] || DEFAULT_CHAINS[profile];
  if (!raw) return null;
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [provider, ...rest] = entry.split(':');
      return { provider: provider.trim(), model: rest.join(':').trim() };
    });
}

// ---------------------------------------------------------------------------
// Circuit breaker.
//
// Without this, a model whose key expired or whose quota is gone is retried on
// EVERY request, so every user waits through a guaranteed failure before the
// fallback even begins. That is how a 20-second request becomes two minutes.
// ---------------------------------------------------------------------------

const breakers = new Map();
const COOLDOWN_MS = { auth: 600000, rateLimit: 60000, transient: 30000 };

const isOpen = (key) => {
  const state = breakers.get(key);
  return Boolean(state && state.openUntil > Date.now());
};

function trip(key, kind) {
  const state = breakers.get(key) || { failures: 0, openUntil: 0 };
  state.failures += 1;
  state.openUntil = Date.now() + (COOLDOWN_MS[kind] ?? COOLDOWN_MS.transient);
  breakers.set(key, state);
}

// `kind` sets the cooldown; `retry` decides whether the SAME model gets a second
// go. A 400 is our own malformed request, so the model is healthy — no cooldown,
// but still worth letting a different provider try, since providers disagree
// about schemas.
function classify(status, message = '') {
  if (status === 401 || status === 403) return { kind: 'auth', retry: false };
  if (status === 429) return { kind: 'rateLimit', retry: true };
  if (status === 400) return { kind: 'badRequest', retry: false, noTrip: true };
  if (status >= 500 || status === 0) return { kind: 'transient', retry: true };
  if (/timeout|aborted/i.test(message)) return { kind: 'transient', retry: true };
  return { kind: 'transient', retry: false };
}

class ProviderError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Provider adapters. Each returns a plain string. Everything provider-specific
// lives here, so adding Anthropic or Mistral later is one function plus one
// environment variable — no client change at all.
// ---------------------------------------------------------------------------

const stripFences = (text) =>
  String(text || '')
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();

async function callGemini({ model, system, user, jsonSchema, maxOutputTokens, temperature }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new ProviderError(401, 'GEMINI_API_KEY not set');

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: {
          temperature: temperature ?? 0.6,
          maxOutputTokens: maxOutputTokens ?? 8192,
          responseMimeType: 'application/json',
          ...(jsonSchema ? { responseSchema: jsonSchema } : {}),
        },
      }),
      signal: AbortSignal.timeout(PER_ATTEMPT_TIMEOUT_MS),
    }
  );

  if (!response.ok) throw new ProviderError(response.status, (await response.text()).slice(0, 400));

  const json = await response.json();
  const candidate = json?.candidates?.[0];

  // A thinking model can spend its entire budget reasoning and return nothing.
  // That is a real failure, not an empty answer — raise it so the chain moves on
  // instead of handing the app empty JSON it cannot decode.
  if (candidate?.finishReason === 'MAX_TOKENS') {
    throw new ProviderError(500, `${model} hit max_output_tokens before finishing`);
  }

  const text = candidate?.content?.parts?.map((part) => part.text).join('') || '';
  if (!text.trim()) throw new ProviderError(500, `${model} returned no content`);
  return stripFences(text);
}

// ---------------------------------------------------------------------------
// Schema translation, Gemini -> OpenAI strict structured outputs.
//
// Both providers can enforce a schema, but they disagree about how to express
// one: Gemini uses uppercase OpenAPI-style types and its own `requiredProperties`,
// while OpenAI's strict mode wants lowercase JSON Schema, `additionalProperties:
// false` on every object, and EVERY property listed in `required` — optional
// fields are expressed by making the type nullable instead.
//
// Translating here is what lets the client send one schema and the server pick
// whichever model is fastest, without the app knowing either dialect exists.
// ---------------------------------------------------------------------------

function nullable(schema) {
  if (Array.isArray(schema.type)) return schema;
  return { ...schema, type: [schema.type, 'null'] };
}

function toOpenAISchema(node) {
  if (!node || typeof node !== 'object') return node;
  const type = String(node.type || '').toLowerCase();

  if (type === 'array') {
    return { type: 'array', items: toOpenAISchema(node.items) };
  }

  if (type === 'object') {
    const properties = node.properties || {};
    // Gemini calls it `requiredProperties` when serialized from the Swift client,
    // and `required` in raw JSON. Accept either.
    const required = new Set(node.requiredProperties || node.required || []);
    const converted = {};
    for (const [key, value] of Object.entries(properties)) {
      const child = toOpenAISchema(value);
      converted[key] = required.has(key) ? child : nullable(child);
    }
    return {
      type: 'object',
      properties: converted,
      required: Object.keys(converted),
      additionalProperties: false,
    };
  }

  const base = { type: type || 'string' };
  if (node.enum) base.enum = node.enum;
  if (node.description) base.description = node.description;
  return base;
}

async function callOpenAI({ model, system, user, jsonSchema, maxOutputTokens, temperature }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new ProviderError(401, 'OPENAI_API_KEY not set');

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: temperature ?? 0.6,
      max_tokens: maxOutputTokens ?? 8192,
      // Strict mode makes OpenAI honour the SAME schema Gemini enforces. Without
      // it, json_object mode only guarantees "valid JSON" — the model happily
      // renames fields, which the app then cannot decode.
      response_format: jsonSchema
        ? {
            type: 'json_schema',
            json_schema: { name: 'plyndi_response', strict: true, schema: toOpenAISchema(jsonSchema) },
          }
        : { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(PER_ATTEMPT_TIMEOUT_MS),
  });

  if (!response.ok) throw new ProviderError(response.status, (await response.text()).slice(0, 400));

  const json = await response.json();
  const text = json?.choices?.[0]?.message?.content || '';
  if (!text.trim()) throw new ProviderError(500, `${model} returned no content`);
  return stripFences(text);
}

const PROVIDERS = { gemini: callGemini, openai: callOpenAI };

// ---------------------------------------------------------------------------

router.post('/', async (req, res) => {
  const {
    profile = 'fast',
    schemaVersion = 1,
    system,
    user,
    jsonSchema,
    maxOutputTokens,
    temperature,
  } = req.body || {};

  if (!system || !user) return res.status(400).json({ error: 'system_and_user_required' });

  // An older install may not understand what the current chain returns. Say so
  // plainly so the app can show "please update" instead of failing to decode.
  if (Number(schemaVersion) < MIN_SCHEMA_VERSION) {
    return res.status(426).json({ error: 'client_too_old', minSchemaVersion: MIN_SCHEMA_VERSION });
  }

  const chain = chainFor(profile);
  if (!chain?.length) return res.status(400).json({ error: 'unknown_profile', profile });

  const startedAt = Date.now();
  const attempts = [];
  let lastError = null;

  for (const { provider, model } of chain) {
    if (Date.now() - startedAt > REQUEST_DEADLINE_MS) break;

    const key = `${provider}:${model}`;
    if (isOpen(key)) {
      attempts.push({ model: key, skipped: 'circuit_open' });
      continue;
    }

    const call = PROVIDERS[provider];
    if (!call) {
      attempts.push({ model: key, skipped: 'unknown_provider' });
      continue;
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const attemptStart = Date.now();
      try {
        const text = await call({ model, system, user, jsonSchema, maxOutputTokens, temperature });
        breakers.delete(key);
        attempts.push({ model: key, ok: true, ms: Date.now() - attemptStart });
        return res.json({ text, provider, model, latencyMs: Date.now() - startedAt, attempts });
      } catch (error) {
        const status = error instanceof ProviderError ? error.status : 0;
        const verdict = classify(status, error.message);
        lastError = error;
        attempts.push({ model: key, ok: false, status, ms: Date.now() - attemptStart, kind: verdict.kind });
        console.error(`[generate] ${key} failed (${status}): ${error.message.slice(0, 200)}`);

        if (!verdict.noTrip) trip(key, verdict.kind);
        if (!verdict.retry || attempt === 1) break;
        await new Promise((resolve) => setTimeout(resolve, 800 + Math.random() * 700));
      }
    }
  }

  // Every model failed. Return the CAUSE, not a generic message — the app needs
  // to tell the traveller "rate limited, try in a minute" rather than "try again".
  const status = lastError instanceof ProviderError ? lastError.status : 0;
  res.status(503).json({
    error: 'all_providers_failed',
    kind: classify(status, lastError?.message || '').kind,
    latencyMs: Date.now() - startedAt,
    attempts,
  });
});

// What is each profile routed to right now, and which models are in cooldown.
router.get('/models', (_req, res) => {
  const now = Date.now();
  res.json({
    profiles: Object.fromEntries(Object.keys(DEFAULT_CHAINS).map((p) => [p, chainFor(p)])),
    breakers: [...breakers.entries()]
      .filter(([, state]) => state.openUntil > now)
      .map(([model, state]) => ({ model, secondsRemaining: Math.round((state.openUntil - now) / 1000) })),
    minSchemaVersion: MIN_SCHEMA_VERSION,
  });
});

module.exports = router;
