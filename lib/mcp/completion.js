'use strict';
// completion/complete's matching (MCP completeness M11, spec section 7):
// the candidates that start with the value, compared case-insensitively,
// first, then those that contain it, each in its declared order; at most
// MAX_VALUES, with the total and whether more were left out. A candidate
// with a hidden character (lib/client-text.js) is a value the client would
// send back changed, so it is left out, never changed (M18).
const {MAX_CANDIDATE_CHARS} = require('../prompt-arguments');
const clientText = require('../client-text');
const MAX_VALUES = 100;
// A lowercased candidate is at most twice as long as the candidate (U+0130
// lowercases to two code units, the most any character grows): a value
// longer than that matches none, and is not lowercased at all.
const MAX_VALUE_CHARS = 2 * MAX_CANDIDATE_CHARS;
const NONE = () => ({values: [], total: 0, hasMore: false});

// candidates: [string]; value: string -> {values, total, hasMore}
function match(candidates, value) {
  if (String(value).length > MAX_VALUE_CHARS) return NONE();
  const v = String(value).toLowerCase();
  const starts = [];
  const contains = [];
  for (const c of Array.isArray(candidates) ? candidates : []) {
    if (typeof(c) !== 'string' || clientText.hasHidden(c)) continue;
    const lower = c.toLowerCase();
    if (lower.startsWith(v)) starts.push(c);
    else if (lower.includes(v)) contains.push(c);
  }
  const all = starts.concat(contains);
  return {values: all.slice(0, MAX_VALUES), total: all.length, hasMore: all.length > MAX_VALUES};
}

module.exports = {match, MAX_VALUES, MAX_VALUE_CHARS};
