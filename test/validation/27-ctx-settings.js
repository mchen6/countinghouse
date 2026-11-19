'use strict';
// ctx.settings and ctx.settingRequired, the handler's side (the module-level
// configuration design, sections 4.5 and 4.6; lib/handler-ctx.js): what a
// call's args.settings gives ctx.settings in a worker. {v, values} gives the
// values and keeps them for v; {v} later gives the kept ones; the worker
// keeps the last four versions it was given, as the main thread's ring
// (lib/settings-gate.js) assumes. Frozen, no prototype, read once per call;
// a field only an own data value. ctx.settingRequired returns the runtime's
// issued SETTING_REQUIRED claim, the setting's name as its message (cut).
// Server-free.
const assert = require('assert');
const handlerCtx = require('../../lib/handler-ctx');

const device = {deviceID: 'd', spec: {device: {friendlyName: 'm'}}};
const ctxWith = (settings) => handlerCtx.buildCtx(device, {input: {}, settings}, {serviceID: 's', actionName: 'a'});

describe('validation 27: ctx.settings and ctx.settingRequired', () => {
  it('no settings: an empty, frozen object with no prototype', () => {
    const s = handlerCtx.buildCtx(device, {input: {}}, {}).settings;
    assert.deepStrictEqual(Object.keys(s), []);
    assert.ok(Object.isFrozen(s));
    assert.strictEqual(Object.getPrototypeOf(s), null);
  });

  it('{v, values}: the values, frozen, no prototype; {v} later: the same values, kept', () => {
    const first = ctxWith({v: 101, values: {units: 'imperial', max: 20}}).settings;
    assert.deepStrictEqual(Object.assign({}, first), {units: 'imperial', max: 20});
    assert.ok(Object.isFrozen(first));
    assert.strictEqual(Object.getPrototypeOf(first), null);
    assert.throws(() => { 'use strict'; first.units = 'metric'; }, TypeError);
    assert.strictEqual(ctxWith({v: 101}).settings, first);
  });

  it('the ring is the shared constant\'s (lib/settings-ring.js: four)', () => {
    assert.strictEqual(require('../../lib/settings-ring').KEPT, 4);
  });

  it('the last four versions are kept: a fifth pushes the oldest out', () => {
    for (const v of [201, 202, 203, 204]) ctxWith({v, values: {n: v}});
    assert.strictEqual(ctxWith({v: 201}).settings.n, 201);
    ctxWith({v: 205, values: {n: 205}});
    assert.deepStrictEqual(Object.keys(ctxWith({v: 201}).settings), [], 'pushed out: empty, never another version\'s');
    assert.strictEqual(ctxWith({v: 205}).settings.n, 205);
  });

  it('{values} with no version (single-thread mode\'s, before module settings ran only with worker threads) is not taken', () => {
    assert.deepStrictEqual(Object.keys(ctxWith({values: {units: 'metric'}}).settings), []);
  });

  it('only own data fields are read: an inherited or accessor field is not', () => {
    const proto = {values: {stolen: true}};
    const settings = Object.create(proto);
    settings.v = 301;
    assert.deepStrictEqual(Object.keys(ctxWith(settings).settings), []);
    const values = {};
    Object.defineProperty(values, 'units', {get: () => 'from a getter', enumerable: true});
    assert.strictEqual(ctxWith({v: 302, values}).settings.units, undefined);
  });

  it('values are kept as their message arrives (holdSettings), so a later {v} finds them; settingsHeld says when a call\'s are not here', () => {
    handlerCtx.holdSettings({settings: {v: 401, values: {n: 401}}});
    assert.strictEqual(handlerCtx.settingsHeld({settings: {v: 401}}), true);
    assert.strictEqual(ctxWith({v: 401}).settings.n, 401);
    assert.strictEqual(handlerCtx.settingsHeld({settings: {v: 499}}), false, 'never given: not held');
    assert.strictEqual(handlerCtx.settingsHeld({settings: {v: 499, values: {n: 1}}}), true, 'its values with it');
    assert.strictEqual(handlerCtx.settingsHeld({input: {}}), true, 'none carried');
    assert.strictEqual(handlerCtx.settingsHeld({settings: {values: {n: 1}}}), false, 'values with no version: never held (settingsOf would not read them)');
    assert.strictEqual(handlerCtx.settingsHeld({settings: {v: 'x', values: {n: 1}}}), false, 'a version that is not a number');
  });

  it('ctx.settingRequired: the issued SETTING_REQUIRED claim, the name its message, cut to 64', () => {
    const ctx = ctxWith(null);
    const claim = ctx.settingRequired('defaultRepo');
    assert.strictEqual(claim.code, 'SETTING_REQUIRED');
    assert.strictEqual(claim.message, 'defaultRepo');
    assert.strictEqual(claim.origin, 'runtime');
    assert.strictEqual(ctx.settingRequired('x'.repeat(100)).message.length, 64);
  });
});
