// L1 (review of #36, F1): under --hardened, Node's permission model refuses
// process.binding, so the lockdown cannot take the TCP, Pipe and UDP handle
// prototypes from the bindings to guard their open(fd). It takes them from
// instances it builds and destroys before any module code runs, without
// opening a socket. A kind it cannot take refuses the load under enforce and
// is reported under audit, never left unguarded in silence.
const assert = require('assert');
const {inWorker, install: installWith, LOCKDOWN, CAPTURE_SOURCE} = require('../helpers/lockdown-worker');

// What a module would do: build a handle from an instance's constructor, as
// the lockdown takes it, and open a descriptor number no process has with it.
const OPENS = `
  ${CAPTURE_SOURCE}
  const code = (f) => { try { f(); return 'allowed'; } catch (e) { return String(e.code); } };
  const opens = {
    TCP: code(() => new (capture.TCP().constructor)(0).open(999999)),
    Pipe: code(() => new (capture.Pipe().constructor)(0).open(999999)),
    UDP: code(() => new (capture.UDP().constructor)().open(999999)),
  };`;
const install = (mode) => installWith({mode: mode});

describe('sandbox 36: handle prototypes under the permission model', function() {
  this.timeout(60000);

  it('takes all three kinds from instances, opening no socket and no file but libuv\'s /dev/null reserve', () => {
    const r = inWorker(`
      const fs = require('fs');
      const fds = () => fs.readdirSync('/proc/self/fd').map((f) => { try { return fs.readlinkSync('/proc/self/fd/' + f); } catch (e) { return null; } })
        .filter((l) => l != null);
      let binding; try { process.binding('tcp_wrap'); binding = 'allowed'; } catch (e) { binding = String(e.code); }
      const before = fds();
      require(${JSON.stringify(LOCKDOWN)});
      const after = fds();
      const added = after.filter((l) => { const i = before.indexOf(l); if (i === -1) return true; before.splice(i, 1); return false; });
      ${install('enforce')}
      ${OPENS}
      return {binding, added, opens, reports};`, {permission: true});
    assert.strictEqual(r.binding, 'ERR_ACCESS_DENIED', `premise: process.binding is refused under --permission: ${JSON.stringify(r)}`);
    // libuv opens one /dev/null per event loop on its first stream handle (its
    // EMFILE reserve); a module's first socket would open it as well.
    assert.ok(r.added.every((l) => l === '/dev/null') && r.added.length <= 1, `descriptors opened: ${JSON.stringify(r.added)}`);
    assert.deepStrictEqual(r.opens, {TCP: 'ERR_ACCESS_DENIED', Pipe: 'ERR_ACCESS_DENIED', UDP: 'ERR_ACCESS_DENIED'});
    assert.deepStrictEqual(r.reports.filter((l) => l.startsWith('descriptor ')), ['descriptor a descriptor (handle open)']);
  });

  it('refuses to install under enforce, naming the kinds it could not take', () => {
    const r = inWorker(`
      require('net').Socket.prototype.connect = function() { throw new Error('unavailable'); };
      ${install('enforce')}
      return {installed: true};`, {permission: true});
    assert.ok(r.thrown != null, JSON.stringify(r));
    assert.ok(/TCP/.test(r.thrown) && /Pipe/.test(r.thrown) && !/UDP/.test(r.thrown), r.thrown);
  });

  it('under audit, installs and reports the kinds it could not take, once', () => {
    const r = inWorker(`
      require('net').Socket.prototype.connect = function() { throw new Error('unavailable'); };
      ${install('audit')}
      return {reports};`, {permission: true});
    assert.ok(r.thrown == null, JSON.stringify(r));
    // Reported as the lockdown's own state, not as a violation by the module.
    const unguarded = r.reports.filter((l) => l.startsWith('unguarded '));
    assert.strictEqual(unguarded.length, 1, JSON.stringify(r.reports));
    assert.ok(/TCP/.test(unguarded[0]) && /Pipe/.test(unguarded[0]) && !/UDP/.test(unguarded[0]), unguarded[0]);
    assert.ok(!r.reports.some((l) => l.startsWith('descriptor ')), JSON.stringify(r.reports));
  });
});
