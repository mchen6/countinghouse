// The brokered FileHandle's streams over a client whose reads answer late
// (30 ms), failing EBADF when the handle has closed meanwhile: a read in
// flight as the handle closes, answered after the close, as a broker that
// answers out of order would (test/fs-broker/29). Run in a plain worker:
// the patch is installed here, over this client alone.
const path = require('path');
const {setImmediate: nextTurn} = require('timers/promises');

module.exports = async () => {
  const patch = require(path.join(__dirname, '..', '..', '..', 'lib', 'fs-broker', 'patch'));
  require('readline');
  const closed = new Set();
  const closes = [];
  const written = new Map(); // fd -> what reached it
  let opened = 0;
  const finite = new Map(); // fd -> bytes left
  const ebadf = () => Object.assign(new Error('EBADF: bad file descriptor, read'), {code: 'EBADF'});
  const client = {
    sync: (op) => { throw new Error(`late-error client: no sync ${op}`); },
    async: async (op, args) => {
      if (op === 'open') {
        opened += 1;
        // (a file of 40 bytes, read to its end; any other never ends)
        if (/\/rf$/.test(String(args[0]))) finite.set(opened, 40);
        return opened;
      }
      if (op === 'close') { if (closed.has(args[0])) throw ebadf(); closed.add(args[0]); closes.push(args[0]); return null; }
      if (op === 'read') {
        await new Promise((resolve) => setTimeout(resolve, 30));
        if (closed.has(args[0])) throw ebadf();
        if (finite.has(args[0])) {
          const n = Math.min(finite.get(args[0]), args[1], 16);
          finite.set(args[0], finite.get(args[0]) - n);
          return new Uint8Array(n).fill(0x62);
        }
        // lines of text ("aaa...\n"), never an end
        const b = new Uint8Array(args[1]).fill(0x61);
        for (let i = 15; i < b.length; i += 16) b[i] = 0x0a;
        return b;
      }
      if (op === 'write') {
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (closed.has(args[0])) throw ebadf();
        if (Buffer.from(args[1]).toString() === 'FAIL') throw Object.assign(new Error('EIO: i/o error, write'), {code: 'EIO'});
        written.set(args[0], (written.get(args[0]) || '') + Buffer.from(args[1]).toString());
        return args[1].length;
      }
      if (op === 'fsync') { await new Promise((resolve) => setTimeout(resolve, 10)); if (closed.has(args[0])) throw ebadf(); return null; }
      // each of a handle's other operations: answered late, refused once closed
      if (['fstat', 'ftruncate', 'fdatasync', 'fchmod', 'fchown', 'futimes'].includes(op)) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (closed.has(args[0])) throw ebadf();
        return op === 'fstat' ? {bigint: false, fields: {size: 0}} : null;
      }
      throw new Error(`late-error client: no ${op}`);
    }
  };
  patch.install(client, {consoleWrite: () => {}});
  const fsp = require('fs/promises');
  const uncaught = [];
  process.on('uncaughtException', (e) => uncaught.push(String((e && e.code) || (e && e.message) || e)));
  const out = {};
  // each case bounded: one that never settles says so, never hangs the test
  const bounded = (name, fn) => Promise.race([fn(), new Promise((resolve) => setTimeout(() => resolve(`${name}: never settled`), 2000))]);
  // a read in flight as the handle closes (the next one, asked for after the
  // first chunk), answered EBADF after the close
  out.inFlight = await bounded('inFlight', async () => {
    const h = await fsp.open('/data/x');
    const s = h.createReadStream({highWaterMark: 64});
    const ev = [];
    await new Promise((resolve) => {
      s.on('error', (e) => ev.push(`error:${e.code}`));
      s.on('close', () => { ev.push('close'); resolve(); });
      s.once('data', () => { ev.push('data'); nextTurn().then(() => h.close()).catch((e) => ev.push(`close-error:${e.code}`)); });
    });
    return ev.join(',');
  });
  // readLines left early, its read ahead answered after the close
  out.early = await bounded('early', async () => {
    const h = await fsp.open('/data/y');
    let n = 0;
    try { for await (const line of h.readLines({highWaterMark: 64})) { if (line != null) n += 1; break; } } finally { await h.close(); }
    return n;
  });
  // the stream destroyed by the module with a read in flight, then the handle
  // closed: no error, one close of the descriptor
  out.destroyed = await bounded('destroyed', async () => {
    const h = await fsp.open('/data/z');
    const s = h.createReadStream({highWaterMark: 64});
    const ev = [];
    s.on('error', (e) => ev.push(`error:${e.code}`));
    await new Promise((resolve) => s.once('data', resolve));
    await nextTurn();
    await new Promise((resolve) => { s.on('close', () => { ev.push('close'); resolve(); }); s.destroy(); });
    await h.close();
    return ev.join(',');
  });
  // a write stream: ended, or destroyed, then the handle closed: the
  // descriptor is the handle's, closed once (by the stream's end, autoClose
  // on, as Node's own, or by the handle)
  for (const how of ['end', 'destroy']) out[`write-${how}`] = await bounded(`write-${how}`, async () => {
    const before = closes.length;
    const h = await fsp.open('/data/w', 'w');
    const w = h.createWriteStream();
    const ev = [];
    w.on('error', (e) => ev.push(`error:${e.code}`));
    // (ended, it finishes; with autoClose: false only a destroyed one closes)
    await new Promise((resolve) => { if (how === 'end') { w.on('finish', resolve); w.end('abc'); } else { w.on('close', resolve); w.write('abc'); w.destroy(); } });
    try { await h.close(); ev.push('handle closed'); } catch (e) { ev.push(`close-error:${e.code}`); }
    return `${ev.join(',')} closes:${closes.length - before}`;
  });
  // the handle closed with writes in flight and buffered (and one with
  // flush): they are done first, every one, then the descriptor closed once;
  // nothing answered EBADF, nothing lost
  for (const flush of [false, true]) out[`write-close${flush ? '-flush' : ''}`] = await bounded(`write-close${flush ? '-flush' : ''}`, async () => {
    const h = await fsp.open('/data/v', 'w');
    const w = h.createWriteStream({flush});
    const ev = [];
    w.on('error', (e) => ev.push(`error:${e.code}`));
    w.write('a');
    w.write('b');
    w.write('c');
    const before = closes.length;
    try { await h.close(); ev.push('handle closed'); } catch (e) { ev.push(`close-error:${e.code}`); }
    return `${ev.join(',')} closes:${closes.length - before} wrote:${written.get(closes[closes.length - 1])}`;
  });
  // a write stream destroyed with its write in flight, then the handle
  // closed at once: the write is answered first (counted), nothing EBADF
  out['write-in-flight'] = await bounded('write-in-flight', async () => {
    const before = closes.length;
    const h = await fsp.open('/data/i', 'w');
    const w = h.createWriteStream({autoClose: false});
    const ev = [];
    w.on('error', (e) => ev.push(`error:${e.code}`));
    w.write('abc');
    await nextTurn();
    w.destroy();
    try { await h.close(); ev.push('handle closed'); } catch (e) { ev.push(`close-error:${e.code}`); }
    await new Promise((resolve) => setTimeout(resolve, 50));
    return `${ev.join(',')} closes:${closes.length - before}`;
  });
  // a write stream that failed, kept by the module (autoClose: false): the
  // close doesn't wait on it; a close asked twice is one close
  out['write-failed'] = await bounded('write-failed', async () => {
    const h = await fsp.open('/data/f', 'w');
    const w = h.createWriteStream({autoClose: false});
    const ev = [];
    await new Promise((resolve) => { w.on('error', (e) => { ev.push(`error:${e.code}`); resolve(); }); w.write('FAIL'); });
    const before = closes.length;
    const first = h.close();
    const second = h.close();
    await Promise.all([first, second]);
    ev.push(first === second ? 'one close' : 'two closes');
    return `${ev.join(',')} closes:${closes.length - before}`;
  });
  // a flush's fsync answered late: done before the handle's descriptor
  // closes (the stream settles once closed), nothing EBADF
  out['flush-late'] = await bounded('flush-late', async () => {
    const before = closes.length;
    const h = await fsp.open('/data/s', 'w');
    const w = h.createWriteStream({flush: true});
    const ev = [];
    w.on('error', (e) => ev.push(`error:${e.code}`));
    w.write('abc');
    try { await h.close(); ev.push('handle closed'); } catch (e) { ev.push(`close-error:${e.code}`); }
    await new Promise((resolve) => setTimeout(resolve, 50));
    return `${ev.join(',')} closes:${closes.length - before}`;
  });
  // a 'close' listener on the handle that throws: the close rejects with
  // its error, as Node's own (never uncaught)
  out['close-listener-throws'] = await bounded('close-listener-throws', async () => {
    const h = await fsp.open('/data/t');
    h.on('close', () => { throw new Error('a listener of its own'); });
    try { await h.close(); return 'resolved'; } catch (e) { return `rejected: ${e.message}`; }
  });
  // a 'close' listener that throws, with a stream open: the close rejects
  // with its error, the stream closes with none (the listener's error is the
  // handle's alone: never an error on a stream nobody listens to)
  out['listener-throws-stream'] = await bounded('listener-throws-stream', async () => {
    const h = await fsp.open('/data/lt');
    const s = h.createReadStream({highWaterMark: 64});
    const ev = [];
    s.on('error', (e) => ev.push(`error:${e.message}`));
    s.on('close', () => ev.push('closed'));
    h.on('close', () => { throw new Error('a listener of its own'); });
    let first;
    try { await h.close(); first = 'resolved'; } catch (e) { first = `rejected: ${e.message}`; }
    await new Promise((resolve) => setTimeout(resolve, 50));
    return `${first}; stream ${ev.includes('closed') ? 'closed' : 'open'}, ${ev.some((x) => x.startsWith('error')) ? 'an error' : 'no error'}`;
  });
  // the handle's own readFile under way as it closes: every read of it done
  // first (the operation held whole, not each call)
  out['handle-readFile'] = await bounded('handle-readFile', async () => {
    const h = await fsp.open('/data/rf');
    const p = h.readFile();
    await h.close();
    try { return `read:${(await p).length}`; } catch (e) { return `readFile-error:${e.code}`; }
  });
  // the handle's own write in flight as it closes: answered first (counted)
  out['handle-write'] = await bounded('handle-write', async () => {
    const before = closes.length;
    const h = await fsp.open('/data/o', 'w');
    const p = h.write('abc');
    await h.close();
    try { await p; } catch (e) { return `write-error:${e.code}`; }
    return `written:${written.get(closes[closes.length - 1])} closes:${closes.length - before}`;
  });
  // a web stream read to its end leaves the handle open, as Node's own
  out['web-stream'] = await bounded('web-stream', async () => {
    const h = await fsp.open('/data/q');
    const reader = h.readableWebStream().getReader();
    let chunks = 0;
    for (let i = 0; i < 3; i++) { const r = await reader.read(); if (r.done) break; chunks += 1; }
    await reader.cancel();
    await nextTurn();
    const open = h.fd >= 0 ? 'open' : 'closed';
    await h.close();
    return `${chunks > 0 ? 'read' : 'empty'} ${open}`;
  });
  // a flush write stream destroyed with its write in flight: its fsync too
  // goes before the descriptor closes, nothing EBADF
  out['flush-destroyed'] = await bounded('flush-destroyed', async () => {
    const before = closes.length;
    const h = await fsp.open('/data/fd', 'w');
    const w = h.createWriteStream({flush: true, autoClose: false});
    const ev = [];
    w.on('error', (e) => ev.push(`error:${e.code}`));
    w.write('abc');
    await nextTurn();
    w.destroy();
    try { await h.close(); ev.push('handle closed'); } catch (e) { ev.push(`close-error:${e.code}`); }
    await new Promise((resolve) => setTimeout(resolve, 50));
    return `${ev.join(',')} closes:${closes.length - before}`;
  });
  // every operation of the handle's own, as the class has them (a method
  // added later is in this list or the test fails), holds the handle open
  // for its whole run: a close asked while it runs waits for it, which
  // answers, never EBADF
  out['every-method'] = await bounded('every-method', async () => {
    const h0 = await fsp.open('/data/m', 'w');
    const proto = Object.getPrototypeOf(h0);
    await h0.close();
    const notOperations = new Set(['constructor', 'fd', 'getAsyncId', 'close', 'createReadStream', 'createWriteStream', 'readLines', 'readableWebStream']);
    const args = {
      read: () => [Buffer.alloc(4), 0, 4, null], write: () => ['abc'], readv: () => [[Buffer.alloc(4)]], writev: () => [[Buffer.from('ab')]],
      readFile: () => [], writeFile: () => ['abc'], appendFile: () => ['abc'], stat: () => [], truncate: () => [0], sync: () => [], datasync: () => [],
      chmod: () => [0o644], chown: () => [0, 0], utimes: () => [0, 0]
    };
    const failed = [];
    for (const k of Object.getOwnPropertyNames(proto)) {
      if (notOperations.has(k)) continue;
      if (args[k] == null) { failed.push(`${k}: no case`); continue; }
      const h = await fsp.open(k === 'readFile' ? '/data/rf' : '/data/m', k === 'readFile' || k === 'read' || k === 'readv' || k === 'stat' ? 'r' : 'w');
      const p = h[k](...args[k]());
      const c = h.close();
      try { await p; } catch (e) { failed.push(`${k}: ${e.code || e.message}`); }
      await c;
    }
    return failed.length === 0 ? 'every one held' : failed.join(', ');
  });
  // a stream asked of a closed handle: refused as Node's own refuses it
  {
    const h = await fsp.open('/data/c');
    await h.close();
    try { h.createReadStream(); out.afterClose = 'made'; } catch (e) { out.afterClose = e.code; }
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
  out.uncaught = uncaught;
  return out;
};
