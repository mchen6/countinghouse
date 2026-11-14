// The drive a module's files carry on Windows (#195), checked on every OS:
// the picker takes a letter the host does not have; the identity loader
// reads <V>:\app back as /app; the broker's path form maps <V>:\app to /app
// and leaves every other drive a host path. Server-free.
const assert = require('assert');
const virtualDrive = require('../../lib/fs-broker/virtual-drive');
const {fromWinFor} = require('../../lib/fs-broker/identity');
const {virtualFormFor} = require('../../lib/fs-broker/roots');

describe('fs-broker 26: a module\'s virtual drive on Windows (#195)', () => {
  afterEach(() => virtualDrive.reset());

  it('the picker under the permission model takes the letter its parent picked (COUNTINGHOUSE_VIRTUAL_DRIVE); outside it, never', () => {
    const had = Object.getOwnPropertyDescriptor(process, 'permission');
    try {
      virtualDrive.reset();
      assert.strictEqual(virtualDrive.pick('win32', () => false, {COUNTINGHOUSE_VIRTUAL_DRIVE: 'Q'}), process.permission != null ? 'Q' : 'M',
        'without --permission the variable is not taken');
      virtualDrive.reset();
      Object.defineProperty(process, 'permission', {value: {has: () => false}, configurable: true});
      assert.strictEqual(virtualDrive.pick('win32', () => { throw new Error('refused'); }, {COUNTINGHOUSE_VIRTUAL_DRIVE: 'Q'}), 'Q');
      virtualDrive.reset();
      assert.strictEqual(virtualDrive.pick('win32', () => true, {COUNTINGHOUSE_VIRTUAL_DRIVE: 'C'}), null, 'C is never one: not in D..Z');
    } finally {
      if (had) Object.defineProperty(process, 'permission', had); else delete process.permission;
      virtualDrive.reset();
    }
  });

  it('the picker: from the middle of the alphabet outward, a letter the host does not have, once per process; none off Windows', () => {
    assert.deepStrictEqual(virtualDrive.ORDER.slice(0, 5), ['M', 'L', 'N', 'K', 'O']);
    const asked = [];
    assert.strictEqual(virtualDrive.pick('win32', (l) => { asked.push(l); return ['M', 'L'].includes(l); }), 'N');
    assert.deepStrictEqual(asked, ['M', 'L', 'N']);
    assert.strictEqual(virtualDrive.pick('win32', () => false), 'N', 'picked once');
    virtualDrive.reset();
    assert.strictEqual(virtualDrive.pick('win32', () => true), null, 'every letter taken: none');
    virtualDrive.reset();
    assert.strictEqual(virtualDrive.pick('linux', () => false), null);
  });

  it('the identity loader reads <V>:\\app back as /app, in either separator and drive case; nothing else', () => {
    const f = fromWinFor('Z');
    assert.strictEqual(f('Z:\\app\\handlers\\x.js'), '/app/handlers/x.js');
    assert.strictEqual(f('z:/app'), '/app');
    for (const other of ['Z:\\apple\\x', 'D:\\app\\x', 'Z:\\data\\x', '/app/x', 'Z:app']) assert.strictEqual(f(other), other);
    assert.strictEqual(fromWinFor(null)('Z:\\app\\x'), 'Z:\\app\\x', 'no drive: unchanged');
  });

  it('the broker\'s path form: <V>:\\app is /app, a string or a Buffer; another drive stays a host path', () => {
    const form = virtualFormFor('win32', 'Z');
    assert.strictEqual(form('Z:\\app\\lib\\data.txt'), '/app/lib/data.txt');
    assert.strictEqual(form('z:/app'), '/app');
    assert.strictEqual(String(form(Buffer.from('Z:\\app\\b'))), '/app/b');
    assert.strictEqual(form('D:\\app\\x'), 'D:\\app\\x');
    assert.strictEqual(form('Z:\\apps\\x'), 'Z:\\apps\\x');
    assert.strictEqual(form('\\data\\x'), '/data/x', 'the namespace\'s other paths as before');
    // the module's /data and /tmp resolved against its cwd <V>:\app
    assert.strictEqual(form('Z:\\data\\w.txt'), '/data/w.txt');
    assert.strictEqual(form('z:/tmp/t'), '/tmp/t');
    assert.strictEqual(String(form(Buffer.from('Z:\\tmp\\b'))), '/tmp/b');
    assert.strictEqual(form('Z:\\database\\x'), 'Z:\\database\\x');
    assert.strictEqual(virtualFormFor('win32', null)('Z:\\app\\x'), 'Z:\\app\\x', 'no drive: a host path, as before');
    assert.strictEqual(virtualFormFor('linux', 'Z')('Z:\\app\\x'), 'Z:\\app\\x', 'POSIX: unchanged');
  });
});
