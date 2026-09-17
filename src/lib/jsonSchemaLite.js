// Minimal, dependency-free JSON Schema subset validator for validating a capability's `context`
// payload before it reaches a provider. No npm dependency added for this: contextSchema only ever
// needs object/string/number/integer/boolean/array/enum/required/nullable, a small enough surface
// that a hand-rolled ~60-line recursive check is safer to reason about here than pulling in a
// general-purpose validator (e.g. ajv) for a handful of primitive checks.
//
// Deliberately permissive on unknown properties (extra fields in `context` are ignored, not
// rejected) unless a schema node explicitly sets `additionalProperties: false` — this mirrors the
// registry's own capability-file validation style (reject what's wrong, don't require exhaustive
// declarations) and keeps a capability file simple to author.

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

// Returns null when valid, or a short human-readable reason string when not.
function validate(schema, value, pathLabel = 'context') {
  if (!schema || typeof schema !== 'object') return null; // no schema = no constraint

  if (value === undefined || value === null) {
    if (schema.nullable) return null;
    if (Array.isArray(schema.required) && schema.required.length > 0) {
      return `${pathLabel} is required`;
    }
    return null;
  }

  const type = schema.type;

  if (type === 'object') {
    if (typeOf(value) !== 'object') return `${pathLabel} must be an object`;
    for (const key of schema.required || []) {
      if (!(key in value)) return `${pathLabel}.${key} is required`;
    }
    const properties = schema.properties || {};
    for (const [key, childSchema] of Object.entries(properties)) {
      const problem = validate(childSchema, value[key], `${pathLabel}.${key}`);
      if (problem) return problem;
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(properties));
      for (const key of Object.keys(value)) {
        if (!allowed.has(key)) return `${pathLabel}.${key} is not an allowed field`;
      }
    }
    return null;
  }

  if (type === 'array') {
    if (!Array.isArray(value)) return `${pathLabel} must be an array`;
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      return `${pathLabel} must have at most ${schema.maxItems} items`;
    }
    if (schema.items) {
      for (let i = 0; i < value.length; i += 1) {
        const problem = validate(schema.items, value[i], `${pathLabel}[${i}]`);
        if (problem) return problem;
      }
    }
    return null;
  }

  if (type === 'string') {
    if (typeof value !== 'string') return `${pathLabel} must be a string`;
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      return `${pathLabel} must be at most ${schema.maxLength} characters`;
    }
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
      return `${pathLabel} must be one of ${JSON.stringify(schema.enum)}`;
    }
    return null;
  }

  if (type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return `${pathLabel} must be a number`;
    return null;
  }

  if (type === 'integer') {
    if (!Number.isInteger(value)) return `${pathLabel} must be an integer`;
    return null;
  }

  if (type === 'boolean') {
    if (typeof value !== 'boolean') return `${pathLabel} must be a boolean`;
    return null;
  }

  return null; // unknown/unspecified type declaration — don't block on it
}

module.exports = { validate };
