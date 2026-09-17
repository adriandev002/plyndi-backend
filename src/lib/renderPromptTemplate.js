// Renders a capability's userPromptTemplate against a context object. The ONLY substitution
// syntax supported is {{context.<dot.path>}} — no conditionals, no loops, no raw string
// concatenation. Every substituted value is JSON-encoded before insertion.
//
// Why JSON-encode even plain strings dropped into prose (so a value can end up quoted mid-
// sentence, e.g. `arriving from "Taipei"`): expense notes, task titles and trip preferences are
// user-controlled text. A raw, un-encoded splice would let a value containing `{{context.` or a
// stray quote/brace/newline reshape the prompt structure or break out of the surrounding
// instructions — this is the actual prompt-injection defense, not a cosmetic choice. JSON-encoding
// guarantees whatever comes back is inert text, at the cost of the value looking JSON-quoted
// inside natural-language prose. That trade is deliberate; see the design doc §8.4.
const PLACEHOLDER = /\{\{\s*context\.([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*)\s*\}\}/g;

function getPath(object, dottedPath) {
  return dottedPath.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), object);
}

function renderPromptTemplate(template, context) {
  return String(template).replace(PLACEHOLDER, (_match, dottedPath) => {
    const value = getPath(context, dottedPath);
    return JSON.stringify(value === undefined ? null : value);
  });
}

module.exports = { renderPromptTemplate };
