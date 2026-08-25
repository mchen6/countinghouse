// deviceID is UUID v5 of friendlyName (lib/call-address.js's
// deviceIDForName), so two modules that pick the same friendlyName collide
// on ID. This is the rule that decides whether a registration is a
// collision (refuse) or a reload (allow).
const assert = require('assert');
const conflict = require('../../lib/device-id-conflict');

describe('device-id-conflict', () => {
  it('reports no conflict when nothing is registered', () => {
    assert.strictEqual(conflict.conflictingModulePath(null, '/modules/a'), null);
    assert.strictEqual(conflict.conflictingModulePath(undefined, '/modules/a'), null);
  });

  it('allows the same module to re-register (reload)', () => {
    const existing = {modulePath: '/modules/a'};
    assert.strictEqual(conflict.conflictingModulePath(existing, '/modules/a'), null);
  });

  it('reports the existing module path when a different module collides', () => {
    const existing = {modulePath: '/modules/a'};
    assert.strictEqual(conflict.conflictingModulePath(existing, '/modules/b'), '/modules/a');
  });

  it('treats an unknown existing modulePath as a conflict', () => {
    // An entry we cannot attribute is not safe to overwrite silently.
    assert.strictEqual(conflict.conflictingModulePath({}, '/modules/b'), '<unknown>');
  });
});
