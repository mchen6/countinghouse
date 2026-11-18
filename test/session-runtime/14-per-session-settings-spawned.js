'use strict';
// Module settings in a per-session module's workers (the module-level
// configuration design, section 4.5: per-session workers are one of the
// paths ctx.settings is delivered on). The module's record keeps the
// settings state its load read (lib/module-manager.js); each session's own
// worker gets it with its first call. Spawned on a shared runtime with
// ch-local's settings file (--settingsFile), two sessions.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {until, perSession, runtime, secretOf, request, shim, NAME} = require('./helpers/per-session');

describe('session-runtime 14: a per-session module\'s workers get its settings', function() {
  this.timeout(120000);
  if (process.platform === 'win32') return;   // the named pipe is C2's
  let home = null;
  let r = null;
  after(async () => {
    if (r != null && r.code === undefined) { r.child.kill('SIGKILL'); await r.exited; }
    if (home != null) fs.rmSync(home, {recursive: true, force: true});
  });

  it('each session\'s worker: ctx.settings from the record\'s state (the default, then the file)', async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-sr14-'));
    const dir = perSession(home, {edit: () => 'module.exports = async (input, ctx) => ({output: {file: 0, units: ctx.settings.units, max: ctx.settings.max, frozen: Object.isFrozen(ctx.settings)}});\n'});
    const pkgFile = path.join(dir, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
    pkg.countinghouse.settings = {units: {type: 'enum', values: ['metric', 'imperial'], default: 'metric'}, max: {type: 'integer', default: 5}};
    fs.writeFileSync(pkgFile, JSON.stringify(pkg));
    const settings = path.join(home, 'settings.json');
    fs.writeFileSync(settings, JSON.stringify({version: 1, values: {[`module.${NAME}.units`]: 'imperial'}}));
    r = runtime(home, ['--settingsFile', settings, '--loadModule', dir]);
    await until(async () => (r.told.some((m) => m.type === 'listening') && secretOf(r) != null) || r.code !== undefined);
    const secret = secretOf(r);
    assert.ok(secret != null, r.err.slice(-2000));
    for (const who of ['A', 'B']) {
      const s = await shim.session(r.socket, secret);
      assert.ok(s.welcome != null, JSON.stringify(s.refused));
      const tools = (await request(s.c, 'tools/list')).result.tools.map((t) => t.name);
      const touch = tools.find((t) => /touch/.test(t));
      const res = await request(s.c, 'tools/call', {name: touch, arguments: {}});
      assert.ok(res.result != null && res.result.isError !== true, `${who}: ${JSON.stringify(res).slice(0, 600)}\n${r.err.slice(-1500)}`);
      assert.deepStrictEqual(res.result.structuredContent, {file: 0, units: 'imperial', max: 5, frozen: true}, who);
      s.c.end();
    }
  });
});
