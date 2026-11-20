// per-session-module fixture (shared runtime R1): see
// test/module-loading/36-per-session-declaration.js and
// test/session-runtime/03-per-session-workers.js. Three counters, so a test
// can tell whose state a call reached: one in its /data, one in its store
// (ctx.redis), one in memory. And what it can see of where it runs, written
// to /data/seen.json, so a test can check no session id reaches it: its
// environment, its argv, the keys and plain values of its ctx, and the text
// of an error its broker gives it.
const fs = require('fs');
let memory = 0;
const plain = (ctx) => {
  const out = {};
  for (const k of Object.keys(ctx || {})) {
    const v = ctx[k];
    out[k] = (typeof(v) === 'function') ? 'function' : (v != null && typeof(v) === 'object') ? Object.keys(v) : v;
  }
  return out;
};
const store = (ctx, op, ...args) => new Promise((resolve) => ctx.redis[op](...args, (e, r) => resolve(e ? null : r)));
module.exports = async (input, ctx) => {
  let n = 0;
  try { n = Number(fs.readFileSync('/data/count', 'utf8')) || 0; } catch (e) { n = 0; }
  n += 1;
  fs.writeFileSync('/data/count', String(n));
  memory += 1;
  let stored = null;
  if (ctx != null && ctx.redis != null) {
    stored = (Number(await store(ctx, 'get', 'count')) || 0) + 1;
    await store(ctx, 'set', 'count', String(stored));
  }
  let errorText = null;
  try { fs.readFileSync('/data/not-here'); } catch (e) { errorText = String(e && e.message); }
  fs.writeFileSync('/data/seen.json', JSON.stringify({env: process.env, argv: process.argv, ctx: plain(ctx), errorText}));
  return {output: {file: n, store: stored, memory}};
};
