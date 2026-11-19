'use strict';
// A module setting's value in the history (#413 rev 3 section 4.2): "a
// value over 64 characters is written cut, with a SHA-256 of the whole".
// One shape for both repositories (countinghouse writes these lines, and
// ch-local's outside-edits reads them; the shared vectors' historyCut):
//
//   - only a string longer than 64 characters (code points, so a surrogate
//     pair is never split) is cut, to its first 64;
//   - beside it, `<field>Sha256`: the lowercase hex SHA-256 of the UTF-8 of
//     JSON.stringify(the whole value);
//   - any other value, and a string of 64 or fewer, is written whole, with
//     no Sha256 field.
//
// The fields a module.* line carries a value in: old and new (a change),
// asked (a request refused, declined or expired), kept (a value not
// applied). Pure: no I/O, no other module.
const crypto = require('crypto');

const LIMIT = 64;
const FIELDS = ['old', 'new', 'asked', 'kept'];
// module.<package>.<setting>, and module.<package> (a line about a module)
const MODULE_LINE = /^module\./;

// value -> {value, sha256} (sha256 null when written whole)
function cut(value) {
  if (typeof(value) !== 'string') return {value, sha256: null};
  const points = Array.from(value);
  if (points.length <= LIMIT) return {value, sha256: null};
  return {value: points.slice(0, LIMIT).join(''), sha256: crypto.createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')};
}

// A history line, its module.* values cut (a copy; any other line as given).
function cutLine(line) {
  if (line == null || typeof(line) !== 'object' || typeof(line.setting) !== 'string' || !MODULE_LINE.test(line.setting)) return line;
  const out = Object.assign({}, line);
  for (const f of FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(out, f)) continue;
    const c = cut(out[f]);
    out[f] = c.value;
    if (c.sha256 != null) out[`${f}Sha256`] = c.sha256;
  }
  return out;
}

module.exports = {cut, cutLine, LIMIT, FIELDS};
