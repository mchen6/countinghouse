'use strict';
// A module resource's URI (MCP completeness M7, spec section 3): the one
// strict parser of countinghouse://m/<module>/<path>. <module> is the
// module's slug as tool names use it (lib/mcp/tool-name.js slugify, deduped
// in the registry: lib/mcp/resources.js), and <path> is matched against that
// module's templates, compiled from their uriTemplate by M0's own rule
// (lib/declarations.js templateOf: literals of unreserved characters, at
// most one {var} a segment, at most 8).
//
// Strict means every step either matches exactly or gives null, and the
// gateway answers every null with one -32602 "Resource not found":
//   - the URI: at most 2048 bytes; the scheme and authority exactly
//     "countinghouse://m/"; a slug of [a-z0-9_]; then a path of unreserved
//     characters, percent-escapes and /, with no empty segment (no query, no
//     fragment, nothing else);
//   - a template: the same number of segments; each literal byte-equal; a
//     variable's segment its literal before, the variable, its literal
//     after. A variable is unreserved characters and percent-escapes only,
//     so it never spans a /. It may be empty: the input schema decides.
//   - a variable's value: percent-decoded as UTF-8, fatally (no lone or
//     overlong byte, no surrogate), and refused when it holds a control
//     character (C0, DEL, C1), a / or a \, or is exactly . or .. -- so a
//     value can never act as a path step in a handler that builds a path
//     from it (the review of the M7 plan). Anything else is the author's to
//     guard.
// M6's stored results (countinghouse://r/) are another path, never this one.
const {templateOf} = require('../declarations');

const PREFIX = 'countinghouse://m/';
const MAX_URI_BYTES = 2048;
const SLUG = /^[a-z0-9_]+$/;
const PATH = /^[A-Za-z0-9._~%/-]+$/;
const RAW_VARIABLE = /^(?:[A-Za-z0-9._~-]|%[0-9A-Fa-f]{2})*$/;
const REFUSED = /[\u0000-\u001f\u007f-\u009f/\\]/;

// a uriTemplate -> {template, segments, variables}, or null for one that is
// no template (the load has refused those already: M0)
function compile(template) {
  const t = templateOf(template);
  if (t == null || t.error != null) return null;
  return {template, segments: t.segments, variables: t.variables};
}

// the full URI template a resource is listed under
function full(slug, template) {
  return `${PREFIX}${slug}/${template}`;
}

// a URI -> {slug, segments}, or null
function split(uri) {
  if (typeof(uri) !== 'string' || Buffer.byteLength(uri, 'utf8') > MAX_URI_BYTES || !uri.startsWith(PREFIX)) return null;
  const rest = uri.slice(PREFIX.length);
  const at = rest.indexOf('/');
  if (at <= 0) return null;
  const slug = rest.slice(0, at);
  const path = rest.slice(at + 1);
  if (!SLUG.test(slug) || path === '' || !PATH.test(path)) return null;
  const segments = path.split('/');
  if (segments.some((s) => s === '')) return null;
  return {slug, segments};
}

// a raw variable -> its value, or null
function decode(raw) {
  if (!RAW_VARIABLE.test(raw)) return null;
  const bytes = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '%') { bytes.push(parseInt(raw.slice(i + 1, i + 3), 16)); i += 2; } else bytes.push(raw.charCodeAt(i));
  }
  let value;
  try {
    value = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(Uint8Array.from(bytes));
  } catch (e) {
    return null;
  }
  if (REFUSED.test(value) || value === '.' || value === '..') return null;
  return value;
}

// a compiled template and a URI's segments -> {variable: value}, or null
function match(compiled, segments) {
  if (compiled == null || !Array.isArray(segments) || segments.length !== compiled.segments.length) return null;
  const vars = {};
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const part = compiled.segments[i];
    if (part.variable == null) {
      if (seg !== part.before) return null;
      continue;
    }
    if (seg.length < part.before.length + part.after.length || !seg.startsWith(part.before) || !seg.endsWith(part.after)) return null;
    const value = decode(seg.slice(part.before.length, seg.length - part.after.length));
    if (value == null) return null;
    vars[part.variable] = value;
  }
  return vars;
}

module.exports = {compile, full, split, match, decode, PREFIX, MAX_URI_BYTES};
