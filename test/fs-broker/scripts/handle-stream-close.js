// A file handle's stream left while a read is in flight, the two ways module
// code does: leaving readLines() early, then closing the handle; and closing
// the handle from a 'data' listener. Whatever error the broker's read gets
// for a handle closed under it must never surface: Node's own FileHandle
// destroys the stream on close, with no error and nothing uncaught.
// ROUNDS repeats both, so a read that lands after the close is seen.
const ROUNDS = 20;

module.exports = async (fs, root) => {
  const fsp = require('fs/promises');
  const file = require('path').posix.join(root, 'lines.txt');
  // ~260 KB: many reads of a 1 KiB highWaterMark, bounded
  fs.writeFileSync(file, 'a line of text\n'.repeat(18000));
  const uncaught = [];
  const onUncaught = (e) => uncaught.push(String((e && e.code) || (e && e.message) || e));
  process.on('uncaughtException', onUncaught);
  const early = [];
  const mid = [];
  let buffered = null;
  let toEnd = null;
  const parity = {};
  try {
    for (let i = 0; i < ROUNDS; i++) {
      const h = await fsp.open(file);
      let n = 0;
      try {
        for await (const line of h.readLines({highWaterMark: 1024})) { if (line != null) n += 1; break; }
      } finally { await h.close(); }
      early.push(n);
    }
    for (let i = 0; i < ROUNDS; i++) {
      const h = await fsp.open(file);
      const s = h.createReadStream({highWaterMark: 1024});
      const ev = [];
      await new Promise((resolve) => {
        s.on('error', (e) => ev.push(`error:${e.code}`));
        s.on('end', () => ev.push('end'));
        s.on('close', () => { ev.push('close'); resolve(); });
        s.once('data', () => { ev.push('data'); h.close().catch((e) => ev.push(`close-error:${e.code}`)); });
      });
      mid.push(ev.join(','));
    }
    // writes buffered as the handle closes: all done first, as Node's own;
    // a read stream read to its end closes (its 'close'), as Node's own
    {
      const out = require('path').posix.join(root, 'w.txt');
      const h = await fsp.open(out, 'w');
      const w = h.createWriteStream();
      const ev = [];
      w.on('error', (e) => ev.push(`error:${e.code}`));
      w.on('finish', () => ev.push('finish'));
      w.on('close', () => ev.push('close'));
      w.write('a');
      w.write('b');
      w.write('c');
      await h.close();
      ev.push('handle closed');
      buffered = `${ev.join(',')} ${fs.readFileSync(out, 'utf8')}`;
      const h2 = await fsp.open(file);
      const r = h2.createReadStream();
      const ev2 = [];
      await new Promise((resolve) => { r.on('end', () => ev2.push('end')); r.on('close', () => { ev2.push('close'); resolve(); }); r.resume(); });
      await h2.close().catch(() => {});
      toEnd = ev2.join(',');
    }
    // Node's own, case by case: a web stream's pending read as its handle
    // closes ends it (done, no error); destroying a stream of autoClose
    // false closes its handle; a close asked again after one rejected
    // resolves
    {
      const h = await fsp.open(file);
      const reader = h.readableWebStream().getReader();
      await reader.read();
      const pending = reader.read();
      const closed = h.close();
      let r;
      try { r = await pending; parity.webClose = r.done ? 'done' : 'value'; } catch (e) { parity.webClose = `error:${e.code || e.name}`; }
      await closed;
    }
    // a web stream reads nothing until asked (the handle's own read gets
    // the file's start); a BYOB reader reads into its own buffer; a second
    // web stream, or one of a closing or closed handle, is refused
    {
      const h = await fsp.open(file);
      const web = h.readableWebStream();
      const b = Buffer.alloc(10);
      await h.read(b, 0, 10, null);
      parity.webNotAhead = b.toString() === fs.readFileSync(file).subarray(0, 10).toString() ? 'start' : 'moved';
      try { h.readableWebStream(); parity.webSecond = 'made'; } catch (e) { parity.webSecond = e.code; }
      const byob = web.getReader({mode: 'byob'});
      const r = await byob.read(new Uint8Array(4));
      parity.webByob = `${r.value.byteLength}`;
      await byob.cancel();
      await h.close();
      try { h.readableWebStream(); parity.webClosed = 'made'; } catch (e) { parity.webClosed = e.code; }
      // (a read under way keeps the handle open across its close: closing)
      const h2 = await fsp.open(file);
      const reading = h2.read(Buffer.alloc(4), 0, 4, 0);
      const closing = h2.close();
      try { h2.readableWebStream(); parity.webClosing = 'made'; } catch (e) { parity.webClosing = `${e.code} ${/closing/.test(e.message) ? 'closing' : 'closed'}`; }
      await reading;
      await closing;
    }
    // a web stream left by break (cancelled, its next read under way), then
    // its handle closed
    {
      const h = await fsp.open(file);
      let chunks = 0;
      for await (const c of h.readableWebStream()) { chunks += c.length > 0 ? 1 : 0; break; }
      const settled = await Promise.race([h.close().then(() => 'closed', (e) => `close-error:${e.code}`), new Promise((resolve) => setTimeout(() => resolve('never settled'), 2000))]);
      parity['web-break'] = `${chunks} ${settled}`;
    }
    // a web stream read to its end, then its handle closed; one paused (its
    // reader stopped, the file larger than its queue), then closed: both close
    for (const how of ['toEnd', 'paused']) {
      const h = await fsp.open(file);
      const reader = h.readableWebStream().getReader();
      if (how === 'toEnd') { while (!(await reader.read()).done) { /* to its end */ } } else await reader.read();
      const settled = await Promise.race([h.close().then(() => 'closed', (e) => `close-error:${e.code}`), new Promise((resolve) => setTimeout(() => resolve('never settled'), 2000))]);
      parity[`web-${how}`] = `${settled} ${h.fd === -1 ? 'fd -1' : 'fd kept'}`;
    }
    {
      const h = await fsp.open(file);
      const s = h.createReadStream({autoClose: false});
      await new Promise((resolve) => { s.on('close', resolve); s.destroy(); });
      await new Promise((resolve) => setTimeout(resolve, 20));
      parity.destroyNoAutoClose = h.fd === -1 ? 'handle closed' : 'handle open';
      await h.close();
    }
    {
      const h = await fsp.open(file);
      let thrown = false;
      h.on('close', () => { if (!thrown) { thrown = true; throw new Error('once'); } });
      try { await h.close(); parity.firstClose = 'resolved'; } catch (e) { parity.firstClose = `rejected:${e.message}`; }
      try { await h.close(); parity.secondClose = 'resolved'; } catch (e) { parity.secondClose = `rejected:${e.message}`; }
    }
    // a read answered after its handle closed lands within a few turns
    await new Promise((resolve) => setTimeout(resolve, 300));
  } finally {
    process.removeListener('uncaughtException', onUncaught);
  }
  return {early: [...new Set(early)], mid: [...new Set(mid)], buffered, toEnd, parity, uncaught};
};
