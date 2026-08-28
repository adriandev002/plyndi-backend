// Strips likely-PII substrings out of every string value in the request body before it's
// forwarded to OpenAI, Gemini, or Places, and before anything about the request gets logged.
// Applies generically to whatever shape the body happens to be — Gemini's `contents`, OpenAI's
// `messages`, a Places query — by walking the object tree rather than knowing every route's own
// field names. One sanitizer, every route; nothing to keep in sync as routes are added.
//
// Deliberately pattern-based redaction (emails, phone numbers, card-like digit runs, SSN-like
// numbers), NOT wholesale removal of financial or health content — an AI feature like budget
// insights or workout coaching genuinely needs the actual amounts, categories, and metrics to be
// useful. This only removes free-text identifiers (an email, a phone number, a card number
// someone typed into a note) that don't need to leave the device at all for the AI to do its job.
//
// Heuristic, not a guarantee: the patterns below are deliberately loose enough to over-redact
// occasionally (a long reference number flagged as "card-like") rather than under-redact — for
// this purpose, a false positive costs a slightly less specific AI answer; a false negative
// leaks something real. Revisit the patterns if a real feature's output quality suffers from it.
const PATTERNS = [
  { name: 'email', regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g },
  { name: 'phone', regex: /(?:\+?\d{1,3}[\s.-]?)?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}\b/g },
  { name: 'card-number', regex: /\b(?:\d[ -]?){13,19}\b/g },
  { name: 'ssn-like', regex: /\b\d{3}-\d{2}-\d{4}\b/g }
];

function redact(value) {
  let result = value;
  for (const { regex } of PATTERNS) {
    result = result.replace(regex, '[redacted]');
  }
  return result;
}

function walk(node) {
  if (typeof node === 'string') return redact(node);
  if (Array.isArray(node)) return node.map(walk);
  if (node && typeof node === 'object') {
    const out = {};
    for (const key of Object.keys(node)) out[key] = walk(node[key]);
    return out;
  }
  return node;
}

module.exports = function sanitizeBody(req, _res, next) {
  if (req.body && typeof req.body === 'object') {
    req.body = walk(req.body);
  }
  next();
};
