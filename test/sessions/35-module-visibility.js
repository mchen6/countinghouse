// M4 Task 1 (module-level configuration, #413 rev 3, section 5.5): the
// hidden set, lib/module-visibility.js, and its bridge into
// lib/session-packs.js's own queries, which every reader of a session's
// view asks (the lists, the call, hop, peer-channel and job paths), so a
// hidden module is refused everywhere with no reader changed. In-process.
const assert = require('assert');

describe('sessions 35: a module going on or off is hidden', () => {
  const visibility = require('../../lib/module-visibility');
  const sessionPacks = require('../../lib/session-packs');
  let goneNow = null;
  beforeEach(() => {
    visibility.resetForTests();
    goneNow = new Set();
    visibility.configure({moduleOf: (deviceID) => ({'dev-a': 'mod-a', 'dev-b': 'mod-b'})[deviceID] || null, isGone: (n) => goneNow.has(n)});
  });
  after(() => visibility.resetForTests());

  it('none() while nothing is hidden; hide, then show, lists the module again', () => {
    assert.strictEqual(visibility.none(), true);
    visibility.hide(['mod-a']);
    assert.strictEqual(visibility.none(), false);
    assert.strictEqual(visibility.listsModule('mod-a'), false);
    assert.strictEqual(visibility.listsModule('mod-b'), true);
    assert.strictEqual(visibility.listsDevice('dev-a'), false);
    assert.strictEqual(visibility.listsDevice('dev-b'), true);
    assert.strictEqual(visibility.listsDevice('dev-unknown'), true);
    visibility.show(['mod-a']);
    assert.strictEqual(visibility.none(), true);
    assert.strictEqual(visibility.listsDevice('dev-a'), true);
  });

  it('gone() drops a module only once it is out of the module map; one still there stays hidden (it failed to unload)', () => {
    visibility.hide(['mod-a', 'mod-b']);
    goneNow.add('mod-a');
    assert.deepStrictEqual(visibility.gone(['mod-a', 'mod-b']), ['mod-b']);
    assert.strictEqual(visibility.listsModule('mod-a'), true);
    assert.strictEqual(visibility.listsModule('mod-b'), false);
    assert.deepStrictEqual(visibility.hiddenOf(['mod-a', 'mod-b', 'mod-c']), ['mod-b']);
  });

  it('every change is told once; a repeat is not a change', () => {
    let told = 0;
    visibility.onChange(() => { told++; });
    visibility.hide(['mod-a']);
    visibility.hide(['mod-a']);
    visibility.show(['mod-a']);
    visibility.show(['mod-a']);
    assert.strictEqual(told, 2);
  });

  // the medium review of M4a, finding 9: one listener for what the lists
  // show, replaced at each configure (a test process starts many runtimes)
  it('configure\'s changed() is the one told: a later configure replaces it', () => {
    const told = [];
    visibility.configure({changed: () => told.push('first')});
    visibility.configure({changed: () => told.push('second')});
    visibility.hide(['mod-a']);
    assert.deepStrictEqual(told, ['second']);
    visibility.resetForTests();
    visibility.hide(['mod-b']);
    assert.deepStrictEqual(told, ['second'], 'reset clears it');
  });

  describe('the bridge: lib/session-packs.js asks the hidden set', () => {
    it('outside a shared runtime (no session view): a hidden module is not listed, its device not, and none() is false', () => {
      visibility.hide(['mod-a']);
      assert.strictEqual(sessionPacks.none(), false);
      assert.strictEqual(sessionPacks.listsModule(null, 'mod-a'), false);
      assert.strictEqual(sessionPacks.listsModule('s1', 'mod-b'), true);
      assert.strictEqual(sessionPacks.listsDevice(null, 'dev-a'), false);
      assert.strictEqual(sessionPacks.listsDeviceOfSession(null, 'dev-a'), false);
      assert.strictEqual(sessionPacks.listsDeviceOfSession('s1', 'dev-b'), true);
      assert.strictEqual(sessionPacks.listsDeviceFor({}, 'dev-a'), false);
      visibility.show(['mod-a']);
      assert.strictEqual(sessionPacks.none(), true);
      assert.strictEqual(sessionPacks.listsDeviceOfSession(null, 'dev-a'), true);
    });
  });
});
