// lib/require-once.js: a module required on first use, then kept (the
// per-call latency work, 2026-11-15: a warm tools/call made 12 require()s
// of loaded modules, 5-8 us each in the runtime's main thread). Lazy: nothing
// is required until the first call, so a call site lazy to avoid a require
// cycle stays so.
const assert = require('assert');
const requireOnce = require('../../lib/require-once');

describe('module-loading 31: requireOnce', () => {
  it('loads nothing until first used, then loads once and keeps it', () => {
    let loads = 0;
    const lib = requireOnce(() => { loads++; return {x: 1}; });
    assert.strictEqual(loads, 0, 'loaded before first use');
    const a = lib();
    const b = lib();
    assert.strictEqual(loads, 1);
    assert.strictEqual(a, b);
  });

  it('a load that throws is tried again on the next use', () => {
    let tries = 0;
    const lib = requireOnce(() => { tries++; if (tries === 1) throw new Error('not yet'); return {ok: true}; });
    assert.throws(() => lib(), /not yet/);
    assert.deepStrictEqual(lib(), {ok: true});
  });

  it('cached: sees a replaced require.cache entry, and loads the module again once its entry is gone', () => {
    const file = require.resolve('../../lib/user-auth');
    const saved = require.cache[file];
    const lib = requireOnce.cached(file);
    try {
      const real = lib();
      assert.strictEqual(real, require('../../lib/user-auth'));
      const stub = () => 'stub';
      require.cache[file] = {id: file, filename: file, loaded: true, exports: stub};
      assert.strictEqual(lib(), stub, 'a replaced entry is what it returns');
      delete require.cache[file];
      assert.strictEqual(typeof lib(), 'function', 'a module whose entry is gone is required again');
      assert.notStrictEqual(lib(), stub);
    } finally {
      if (saved != null) require.cache[file] = saved;
    }
  });
});
