// R2-1 Task 4's re-review (items 1, 2 and 7): the main thread's copy of a
// module's package.json, whose countinghouse.calls it enforces, is read
// before any of the module's code runs, and validation counts: a module
// validated and then loaded is pinned at the copy read before its
// validation. Under audit the file is still replaceable by routes the file
// broker does not see (a rename of an ancestor, a child process), so every
// re-pin -- an operator's load, reload or restart, a supervised restart, a
// server restart -- is compared with the module's previous pin, and each
// call added since is logged as an error, in full, adopted or not.
// Server-free: lib/manifest-pins.js alone.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {mkdtemp} = require('../helpers/test-tmp');

const A = 'token-callee/tokenCallee.bump';
const B = 'compose-callee/calleeService.double';

describe('composition 22: declarations pinned before the module runs, and every added call logged', () => {
  let base = null;
  let mod = null;
  let lines = null;
  const write = (calls, extra) => fs.writeFileSync(path.join(mod, 'package.json'),
    JSON.stringify(Object.assign({name: 'm', description: 'private-note-xyz', countinghouse: {calls: calls}}, extra || {})));
  // required where used, so each case fails on its own before the module exists
  const pins = () => new (require('../../lib/manifest-pins').ManifestPins)({recordDir: () => path.join(base, 'store', '.pins'), log: (line) => lines.push(line)});
  const callsOf = (pkg) => pkg.countinghouse.calls;
  const added = (call, how) => lines.filter((l) => l.includes(JSON.stringify(call)) && l.includes(`(${how}`));

  beforeEach(() => {
    base = mkdtemp('manifest-pins-');
    mod = path.join(base, 'm');
    fs.mkdirSync(mod);
    lines = [];
  });
  afterEach(() => fs.rmSync(base, {recursive: true, force: true}));

  it('a first load pins the file as read and logs nothing', () => {
    write([A]);
    assert.deepStrictEqual(callsOf(pins().pin('m', mod, true)), [A]);
    assert.deepStrictEqual(lines, []);
  });

  it('validation pins first: the next operator load takes the copy read before validation; a call added in between is logged, not adopted', () => {
    const p = pins();
    write([A]);
    p.forValidation(mod);
    write([A, B]);   // what a module could do during its validation, past the file broker
    assert.deepStrictEqual(callsOf(p.pin('m', mod, true)), [A]);
    assert.strictEqual(added(B, 'not adopted').length, 1, lines.join('\n'));
    assert.ok(lines.every((l) => l.includes('m')), lines.join('\n'));
    // the validation's copy is taken once: an operator's reload reads the file again
    lines = [];
    assert.deepStrictEqual(callsOf(p.pin('m', mod, true)), [A, B]);
    assert.strictEqual(added(B, 'adopted').length, 1, lines.join('\n'));
  });

  it('a supervised restart keeps the pin; a call added on disk is logged at each one, not adopted', () => {
    const p = pins();
    write([A]);
    p.pin('m', mod, true);
    write([A, B]);
    assert.deepStrictEqual(callsOf(p.pin('m', mod, false)), [A]);
    assert.deepStrictEqual(callsOf(p.pin('m', mod, false)), [A]);
    assert.strictEqual(added(B, 'not adopted').length, 2, lines.join('\n'));
    assert.strictEqual(added(B, 'adopted').length, 0, lines.join('\n'));
  });

  it('an operator\'s reload adopts the file and logs each call added since the previous pin', () => {
    const p = pins();
    write([A]);
    p.pin('m', mod, true);
    write([A, B, 'x/y.z']);
    assert.deepStrictEqual(callsOf(p.pin('m', mod, true)), [A, B, 'x/y.z']);
    assert.strictEqual(added(B, 'adopted').length, 1, lines.join('\n'));
    assert.strictEqual(added('x/y.z', 'adopted').length, 1, lines.join('\n'));
    assert.strictEqual(added(A, 'adopted').length, 0, 'a call already pinned is not logged');
  });

  it('a server restart compares with the recorded pin; an unchanged file logs nothing', () => {
    write([A]);
    pins().pin('m', mod, true);
    pins().pin('m', mod, true);
    assert.deepStrictEqual(lines, [], 'unchanged');
    write([A, B]);
    assert.deepStrictEqual(callsOf(pins().pin('m', mod, true)), [A, B]);
    assert.strictEqual(added(B, 'adopted').length, 1, lines.join('\n'));
  });

  it('the log names the module and the call, nothing else from the file; the record keeps only the calls', () => {
    write([A]);
    pins().pin('m', mod, true);
    write([A, B]);
    pins().pin('m', mod, true);
    assert.ok(lines.length > 0);
    assert.ok(!lines.some((l) => l.includes('private-note-xyz')), lines.join('\n'));
    const records = fs.readdirSync(path.join(base, 'store', '.pins'));
    assert.strictEqual(records.length, 1, records.join(', '));
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(base, 'store', '.pins', records[0]), 'utf8')), {calls: [A, B]});
  });

  it('a file unreadable for a moment does not reset what the next pin compares with', () => {
    const p = pins();
    write([A, B]);
    p.pin('m', mod, true);
    fs.writeFileSync(path.join(mod, 'package.json'), '{"name": "m"');
    assert.strictEqual(p.pin('m', mod, true), null);
    write([A, B]);
    lines = [];
    p.pin('m', mod, true);
    assert.deepStrictEqual(lines, [], 'the declared calls were reported as added');
    // and across a server restart
    fs.writeFileSync(path.join(mod, 'package.json'), '{"name": "m"');
    pins().pin('m', mod, true);
    write([A, B]);
    lines = [];
    pins().pin('m', mod, true);
    assert.deepStrictEqual(lines, [], 'the record was reset');
  });

  it('an unchanged pin does not rewrite its record', () => {
    write([A]);
    const p = pins();
    p.pin('m', mod, true);
    const file = path.join(base, 'store', '.pins', 'm.json');
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(file, old, old);
    p.pin('m', mod, false);
    p.pin('m', mod, true);
    pins().pin('m', mod, true);
    assert.strictEqual(fs.statSync(file).mtimeMs, old.getTime());
  });

  // Task 4's last re-review, MED-1: the copy read before validation is not
  // memory only, is compared with what came before, and is found by the
  // path as named and by package name.
  const logged = (call) => lines.filter((l) => l.includes(JSON.stringify(call)));

  it('validate, widen, restart, load: the call added after validation is logged', () => {
    write([A]);
    pins().forValidation(mod);
    write([A, B]);
    pins().pin('m', mod, true);   // a new server: the validation's copy is gone, its record is not
    assert.strictEqual(logged(B).length, 1, lines.join('\n'));
  });

  it('validate twice with a widen in between: the second validation logs the added call', () => {
    const p = pins();
    write([A]);
    p.forValidation(mod);
    write([A, B]);
    p.forValidation(mod);
    assert.strictEqual(logged(B).length, 1, lines.join('\n'));
  });

  it('the module root swapped for a symlink to a staged directory during validation: the load takes the copy, and logs the call', () => {
    const p = pins();
    write([A]);
    p.forValidation(mod);
    const staged = path.join(base, 'staged');
    fs.mkdirSync(staged);
    fs.writeFileSync(path.join(staged, 'package.json'), JSON.stringify({name: 'm', countinghouse: {calls: [A, B]}}));
    fs.renameSync(mod, path.join(base, 'm-old'));
    fs.symlinkSync(staged, mod);
    assert.deepStrictEqual(callsOf(p.pin('m', mod, true)), [A]);
    assert.ok(logged(B).length >= 1, lines.join('\n'));
  });

  it('the copy is found by package name too, loaded by another path to the module', () => {
    const p = pins();
    write([A]);
    p.forValidation(mod);
    write([A, B]);
    const other = path.join(base, 'other-name');
    fs.symlinkSync(mod, other);
    assert.deepStrictEqual(callsOf(p.pin('m', other, true)), [A]);
  });

  it('a copy found by package name only, from another directory: what it adds to the file loaded is logged', () => {
    const p = pins();
    const staging = path.join(base, 'staging');
    fs.mkdirSync(staging);
    fs.writeFileSync(path.join(staging, 'package.json'), JSON.stringify({name: 'm', countinghouse: {calls: [A, B]}}));
    p.forValidation(staging);
    write([A]);
    lines = [];
    p.pin('m', mod, true);
    assert.ok(lines.some((l) => l.includes(JSON.stringify(B)) && /another path/.test(l)), lines.join('\n'));
  });

  // MED-2: the record cannot be steered by a planted link.
  it('a symlink planted where the record is written: not followed', () => {
    write([A]);
    const dir = path.join(base, 'store', '.pins');
    fs.mkdirSync(dir, {recursive: true});
    const target = path.join(base, 'target');
    fs.writeFileSync(target, 'untouched');
    // the name the record's temporary file used to have
    fs.symlinkSync(target, path.join(dir, `m.json.${process.pid}.tmp`));
    pins().pin('m', mod, true);
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'untouched');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'm.json'), 'utf8')), {calls: [A]});
  });

  it('a record replaced by a symlink is not read: every declared call is logged', () => {
    write([A]);
    pins().pin('m', mod, true);
    const dir = path.join(base, 'store', '.pins');
    const forged = path.join(base, 'forged.json');
    fs.writeFileSync(forged, JSON.stringify({calls: [A, B]}));
    fs.unlinkSync(path.join(dir, 'm.json'));
    fs.symlinkSync(forged, path.join(dir, 'm.json'));
    write([A, B]);
    pins().pin('m', mod, true);
    assert.strictEqual(logged(B).length, 1, lines.join('\n'));
  });

  // LOW: each call capped in the log, and the lines per re-pin.
  it('a long call is logged capped at 256 characters, and the lines of one re-pin are capped', () => {
    const long = `x/${'y'.repeat(1000)}.z`;
    const many = Array.from({length: 100}, (_, i) => `d${i}/s.a`);
    write([A]);
    const p = pins();
    p.pin('m', mod, true);
    write([A, long].concat(many));
    p.pin('m', mod, true);
    assert.ok(!lines.some((l) => l.includes('y'.repeat(300))), 'the call was logged in full');
    assert.ok(lines.some((l) => l.includes(`${long.slice(0, 256)}…`)), lines[0]);
    assert.ok(lines.length <= 20, `${lines.length} lines`);
    assert.ok(lines.some((l) => /more added calls not shown/.test(l)));
  });

  it('a package.json that cannot be read is logged, without its content, and pins no declarations', () => {
    fs.writeFileSync(path.join(mod, 'package.json'), '{"name": "m", "secret": "zzz-not-json');
    assert.strictEqual(pins().pin('m', mod, true), null);
    assert.ok(lines.some((l) => /m: its package\.json could not be read/.test(l)), lines.join('\n'));
    assert.ok(!lines.some((l) => l.includes('zzz')), lines.join('\n'));
  });
});
