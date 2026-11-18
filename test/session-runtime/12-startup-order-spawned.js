'use strict';
// The startup levers' (2), spawned on a shared runtime (the per-session
// fixture needs one): the startup list's modules load several at once, and
// what a session is listed is byte for byte what a one-at-a-time start lists.
// - slow-load-module, first in the list, takes about 3 s to load, so the
//   module after it finishes first (completion reversed);
// - fails-load-module throws when loaded: the others load, and discovery ends
//   once;
// - per-session-module is a SessionModuleRecord (no worker until a session
//   calls it), the case A asked to cover.
// The two starts are the same runtime with COUNTINGHOUSE_TEST_STARTUP_LIMIT
// 2 and 1 (read only under the test flag): the default is 1 on a 2-CPU
// machine, as CI's runners are.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {ROOT, until, perSession, runtime, secretOf, request, shim} = require('./helpers/per-session');

const FIXTURES = path.join(ROOT, 'test', 'fixtures');
// a fixture copied into the home as a scenario (this runtime lists scenarios)
function scenario(home, name) {
  const dir = path.join(home, 'pack', name);
  fs.cpSync(path.join(FIXTURES, name), dir, {recursive: true});
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  pkg.countinghouse = Object.assign({}, pkg.countinghouse, {role: 'scenario'});
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
  return dir;
}

describe('session-runtime 12: startup loads at once, listed as one at a time lists', function() {
  this.timeout(180000);
  if (process.platform === 'win32') return; // the named pipe is C2's
  const homes = [];
  const runs = [];
  after(async() => {
    for (const r of runs) if (r.code === undefined) { r.child.kill('SIGKILL'); await r.exited; }
    for (const h of homes) fs.rmSync(h, {recursive: true, force: true});
  });

  // a runtime started with the four modules; the session's tools/list once
  // discovery is over (it is held until then), and the runtime's log
  async function started(limit) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-sr12-'));
    homes.push(home);
    if (limit != null) process.env.COUNTINGHOUSE_TEST_STARTUP_LIMIT = String(limit);
    let r = null;
    try {
      r = runtime(home, [scenario(home, 'slow-load-module'), scenario(home, 'fails-load-module'), scenario(home, 'handler-map-module'), perSession(home)]
        .flatMap((m) => ['--loadModule', m]));
    } finally {
      delete process.env.COUNTINGHOUSE_TEST_STARTUP_LIMIT;
    }
    runs.push(r);
    await until(async() => (r.told.some((m) => m.type === 'listening') && secretOf(r) != null) || r.code !== undefined);
    const secret = secretOf(r);
    assert.ok(secret != null, `no secret: ${r.log().slice(-3000)}`);
    const a = await shim.session(r.socket, secret);
    assert.ok(a.welcome != null, JSON.stringify(a.refused));
    const list = await request(a.c, 'tools/list');
    assert.ok(list != null && list.result != null, JSON.stringify(list));
    await until(async() => /all module discovered/.test(r.log()));
    a.c.end();
    return {r, home, tools: list.result.tools, log: r.log()};
  }
  // when a load answered (loadAllModules' own line, completion order)
  const answeredAt = (log, dir) => log.indexOf(`load local module from path: ${dir}`);

  it('the module after a slow one finishes first; the list is byte for byte the one-at-a-time start\'s; discovery ends once', async () => {
    const atOnce = await started(2);   // the default is 1 on a 2-CPU machine
    const inSeries = await started(1);
    // completion reversed only when several load at once
    const at = (run, name) => answeredAt(run.log, path.join(run.home, 'pack', name));
    assert.ok(at(atOnce, 'handler-map-module') !== -1 && at(atOnce, 'slow-load-module') !== -1, atOnce.log.slice(-3000));
    assert.ok(at(atOnce, 'handler-map-module') < at(atOnce, 'slow-load-module'), 'at once: the quick module finished before the slow one');
    assert.ok(at(inSeries, 'slow-load-module') < at(inSeries, 'handler-map-module'), 'one at a time: in the list\'s order');
    // listed in the list's order either way: the slow module's ping before
    // the quick one's touch, though the quick one finished first
    for (const run of [atOnce, inSeries]) {
      const names = run.tools.map((t) => t.name);
      const at = (w) => names.findIndex((n) => n.includes(w));
      assert.ok(at('ping') !== -1 && at('ping') < at('touch'), `listed in the list's order: ${names.join(' ')}`);
    }
    // the failing module refused, the others listed
    for (const run of [atOnce, inSeries]) {
      assert.match(run.log, /fails-load-module/);
      assert.strictEqual((run.log.match(/all module discovered/g) || []).length, 1, 'discovery ends once');
      const names = run.tools.map((t) => t.name).join(' ');
      for (const w of ['ping', 'touch']) assert.match(names, new RegExp(w), names);
    }
    assert.strictEqual(JSON.stringify(atOnce.tools), JSON.stringify(inSeries.tools), 'the same list, in the same order');
  });
});
