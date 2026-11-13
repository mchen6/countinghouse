// Libraries loaded on first use (lib/lazy-require.js), server-free; review of
// 323b33a, 2026-11-12. Each case runs in a child process, so what it plants
// in require.cache stays there.
// - Loaded once and kept: a require.cache entry planted after the first use
//   is never read (a remote service client re-required postman-request on
//   every post).
// - A library that cannot be loaded is answered through the helper's
//   callback, never thrown out of CHUtil.request, CHUtil.createSOAPClient or
//   a remote service client's invoke.
// The only address used is 127.0.0.1:1, which refuses at once.
const assert = require('assert');
const path = require('path');
const {spawnSync} = require('child_process');

const ROOT = path.join(__dirname, '..', '..');

function child(code) {
  const r = spawnSync(process.execPath, ['-e', code], {cwd: ROOT, encoding: 'utf8', timeout: 30000});
  const line = r.stdout.split('\n').filter((l) => l.startsWith('RESULT ')).pop();
  assert.ok(line != null, `no result (exit ${r.status}): ${r.stderr.slice(-2000)}`);
  return JSON.parse(line.slice('RESULT '.length));
}

// Plants, for the library at `name`, an entry whose exports throw when read.
const PLANT_FAILING = `
function plantFailing(name) {
  const file = require.resolve(name);
  const m = {id: file, filename: file, loaded: true, children: [], paths: []};
  Object.defineProperty(m, 'exports', {get() { const e = new Error('cannot load ' + name); e.code = 'LOAD_TEST'; throw e; }});
  require.cache[file] = m;
}
const out = (v) => console.log('RESULT ' + JSON.stringify(v));
`;

describe('module-loading 19: libraries loaded on first use', function() {
  this.timeout(60000);

  it('a remote service client keeps postman-request after its first post: an entry planted later is not read', () => {
    const r = child(`${PLANT_FAILING}
      const ServiceClient = require('./lib/service-client');
      const c = new ServiceClient(null, true, false, 'k', 'd', 's');
      c.deviceBaseUrl = 'http://127.0.0.1:1';
      c.invoke({actionName: 'a', input: {}}, (first) => {
        const file = require.resolve('postman-request');
        let planted = 0;
        require.cache[file] = {id: file, filename: file, loaded: true, exports: (o, cb) => { planted++; cb(new Error('planted')); }};
        c.invoke({actionName: 'a', input: {}}, (second) => out({first: first && first.code, second: second && (second.code || second.message), planted}));
      });`);
    assert.deepStrictEqual(r, {first: 'ECONNREFUSED', second: 'ECONNREFUSED', planted: 0});
  });

  [
    ['CHUtil.request', 'postman-request', "require('./lib/countinghouse-util').request({url: 'http://127.0.0.1:1/'}, cb)"],
    ['CHUtil.createSOAPClient', 'soap', "require('./lib/countinghouse-util').createSOAPClient('http://127.0.0.1:1/?wsdl', {}, cb)"],
    ['a remote service client', 'postman-request', "(() => { const S = require('./lib/service-client'); const c = new S(null, true, false, 'k', 'd', 's'); c.deviceBaseUrl = 'http://127.0.0.1:1'; c.invoke({actionName: 'a', input: {}}, cb); })()"]
  ].forEach(([what, lib, call]) => {
    it(`${what}: a library that cannot be loaded is answered through the callback, after the call returns`, () => {
      const r = child(`${PLANT_FAILING}
        plantFailing('${lib}');
        let returned = false;
        let threw = null;
        const cb = (err) => out({threw, returned, code: err != null ? err.code : null});
        try { ${call}; } catch (e) { threw = e.code || e.message; out({threw, returned, code: null}); }
        returned = true;`);
      assert.deepStrictEqual(r, {threw: null, returned: true, code: 'LOAD_TEST'});
    });
  });
});
