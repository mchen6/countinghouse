'use strict';
// JSON pointers as the load reads them (#400's high reviews): the one
// decoder (pointerTokens) and the one local-ref resolver (resolveLocal,
// resolveTokens), for lib/schema-safety.js, the schema walk
// (lib/client-text.js) and the schema route alike. No dependencies: a
// validation worker loads it at boot, as it loads both of those, and
// nothing of the runtime's after its lockdown (#194).
const MAX_REF_HOPS = 64;
const NOWHERE = Symbol('nowhere');
const isObject = (v) => v != null && typeof(v) === 'object' && !Array.isArray(v);

// A JSON pointer's tokens ('' or '/a/b', the text after a ref's '#'): each
// token's ~1 and ~0 unescaped, then decoded (decodeURI); null when it is
// no pointer or a token can't be decoded. The one decoder: the load's
// refs, the schema walk's and the schema route's paths all name a node by
// it (#400's high review).
function pointerTokens(pointerText) {
  if (typeof(pointerText) !== 'string') return null;
  if (pointerText === '') return [];
  if (!pointerText.startsWith('/')) return null;
  try {
    return pointerText.slice(1).split('/').map((raw) => decodeURI(raw.replace(/~1/g, '/').replace(/~0/g, '~')));
  } catch (e) {
    return null;
  }
}

// a declared schema pointer's tokens (an action's input.schema, the schema
// route's path): '/' is the whole document, as the load reads one
const declaredTokens = (pointer) => (pointer === '/' ? [] : pointerTokens(pointer));

function resolveLocal(doc, ref, hops = 0) {
  if (hops > MAX_REF_HOPS || typeof(ref) !== 'string' || !ref.startsWith('#')) return NOWHERE;
  const tokens = pointerTokens(ref.slice(1));
  if (tokens == null) return NOWHERE;
  return resolveTokens(doc, tokens, hops);
}
// the node tokens name, each $ref met on the way followed (resolveLocal)
function resolveTokens(doc, tokens, hops = 0) {
  let node = doc;
  for (const token of tokens) {
    while (isObject(node) && typeof(node.$ref) === 'string' && !Object.prototype.hasOwnProperty.call(node, token)) {
      node = resolveLocal(doc, node.$ref, hops + 1);
      if (node === NOWHERE) return NOWHERE;
    }
    if (node == null || typeof(node) !== 'object' || !Object.prototype.hasOwnProperty.call(node, token)) return NOWHERE;
    node = node[token];
  }
  return node;
}

module.exports = {pointerTokens, declaredTokens, resolveLocal, resolveTokens, MAX_REF_HOPS, NOWHERE};
