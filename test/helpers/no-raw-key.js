// Where a raw API key turns up in a structure (CLAUDE.md: a raw API key never
// goes into a Map key or long-lived structure; key by its meterId): every
// path through Maps (their keys and values), Sets, arrays and plain objects
// (their keys and values) whose string holds `key`, as a readable path.
// Functions, and an object's prototype, are not walked: a closure's own
// variables are out of a walk's reach.
function rawKeyPaths(value, key, {skip = () => false} = {}) {
  const found = [];
  const seen = new Set();
  const walk = (v, at) => {
    if (typeof(v) === 'string') { if (v.includes(key)) found.push(at); return; }
    if (v == null || typeof(v) !== 'object' || seen.has(v) || skip(v)) return;
    seen.add(v);
    if (v instanceof Map) {
      let i = 0;
      for (const [k, x] of v) { walk(k, `${at}<key ${i}>`); walk(x, `${at}<${typeof(k) === 'string' && !k.includes(key) ? k : i}>`); i += 1; }
      return;
    }
    if (v instanceof Set || Array.isArray(v)) {
      let i = 0;
      for (const x of v) walk(x, `${at}[${i++}]`);
      return;
    }
    for (const k of Object.keys(v)) {
      if (k.includes(key)) found.push(`${at}{a property named by the key}`);
      walk(v[k], `${at}.${k.includes(key) ? '<the key>' : k}`);
    }
  };
  walk(value, '');
  return found;
}

module.exports = {rawKeyPaths};
