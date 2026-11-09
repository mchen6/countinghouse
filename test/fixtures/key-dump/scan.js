// scan.js -- walks everything module code can reach from the roots given and
// reports where any needle string, or a property named in `keys`, is found.
// Used by test/auth/30 to prove no API key, user name or Redis URL reaches a
// module. Data properties, Map keys and values, Set values, WeakRef targets,
// and Buffer / typed-array bytes (decoded as UTF-8) are searched. Getters are
// never called (side effects); each one skipped is reported by path, so the
// test shows what wasn't inspected. A cycle guard, a depth cap and a node
// budget bound the walk, and hitting either cap is reported too.
// The needles arrive reversed, so the call's own input, which the walk also
// reaches, doesn't contain them; they're reversed back here, into a local the
// walk can't see. A hit names the needle by index, never by value.
const MAX_DEPTH = 14;
const BUDGET = 2000000;

module.exports = function scan(roots, reversed, keys) {
  const needles = (reversed || []).map((n) => String(n).split('').reverse().join(''));
  const hits = [];
  const accessors = [];
  const seen = new Set();
  let budget = BUDGET;
  let depthCapped = 0;
  const search = (text, path) => {
    needles.forEach((n, i) => { if (text.includes(n)) hits.push({needle: i, path: path}); });
  };
  const visit = (v, path, depth) => {
    if (budget <= 0) return;
    budget--;
    if (depth > MAX_DEPTH) { depthCapped++; return; }
    if (typeof v === 'string') return search(v, path);
    if (v == null || (typeof v !== 'object' && typeof v !== 'function')) return;
    if (seen.has(v)) return;
    seen.add(v);
    try {
      if (ArrayBuffer.isView(v)) return search(Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('utf8'), `${path}<bytes>`);
      if (v instanceof ArrayBuffer) return search(Buffer.from(v).toString('utf8'), `${path}<bytes>`);
      if (typeof WeakRef === 'function' && v instanceof WeakRef) visit(v.deref(), `${path}.deref()`, depth + 1);
      if (v instanceof Map) v.forEach((x, k) => { visit(k, `${path}.<mapkey>`, depth + 1); visit(x, `${path}.get(${String(k).slice(0, 24)})`, depth + 1); });
      if (v instanceof Set) v.forEach((x) => visit(x, `${path}.<setitem>`, depth + 1));
    } catch (e) { /* a foreign or revoked object */ }
    let own = [];
    try { own = Reflect.ownKeys(v); } catch (e) { return; }
    own.forEach((k) => {
      const name = (typeof k === 'symbol') ? k.toString() : k;
      if (keys.indexOf(name) !== -1) hits.push({key: name, path: path});
      let d = null;
      try { d = Object.getOwnPropertyDescriptor(v, k); } catch (e) { d = null; }
      if (d == null) return;
      if ('value' in d) return visit(d.value, `${path}.${name}`, depth + 1);
      if (typeof d.get === 'function') accessors.push(`${path}.${name}`);
    });
    let proto = null;
    try { proto = Object.getPrototypeOf(v); } catch (e) { proto = null; }
    if (proto != null && proto !== Object.prototype && proto !== Function.prototype && proto !== Array.prototype) visit(proto, `${path}.<proto>`, depth + 1);
  };
  Object.keys(roots).forEach((r) => visit(roots[r], r, 0));
  return {hits: hits, accessors: accessors, budgetExhausted: budget <= 0, depthCapped: depthCapped, visited: BUDGET - budget};
};
