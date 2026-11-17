'use strict';
// completion/complete's matching (MCP completeness M11, spec section 7):
// the candidates that start with the value, compared case-insensitively,
// first, then those that contain it, each in its declared order; at most
// MAX_VALUES, with the total and whether more were left out.
const MAX_VALUES = 100;
// a value as long as any candidate can be: a longer one matches none
const MAX_VALUE_CHARS = 256;

// candidates: [string]; value: string -> {values, total, hasMore}
function match(candidates, value) {
  const v = String(value).toLowerCase();
  const starts = [];
  const contains = [];
  for (const c of Array.isArray(candidates) ? candidates : []) {
    if (typeof(c) !== 'string') continue;
    const lower = c.toLowerCase();
    if (lower.startsWith(v)) starts.push(c);
    else if (lower.includes(v)) contains.push(c);
  }
  const all = starts.concat(contains);
  return {values: all.slice(0, MAX_VALUES), total: all.length, hasMore: all.length > MAX_VALUES};
}

module.exports = {match, MAX_VALUES, MAX_VALUE_CHARS};
