// leave.js -- leaves a file handle's stream while a read is in flight
// (test/fs-broker/29): "early" leaves readLines() after its first line and
// closes the handle; "mid" closes the handle from the stream's first 'data';
// "nothing" just answers, to show the worker is still up.
const fs = require('fs');
const FILE = '/data/lines.txt';

module.exports = async (input) => {
  if (input.how === 'nothing') return {output: {how: input.how, detail: 'up'}};
  if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, 'a line of text\n'.repeat(18000));
  const h = await fs.promises.open(FILE);
  if (input.how === 'early') {
    let n = 0;
    try {
      for await (const line of h.readLines({highWaterMark: 1024})) { if (line != null) n += 1; break; }
    } finally { await h.close(); }
    return {output: {how: input.how, detail: String(n)}};
  }
  const s = h.createReadStream({highWaterMark: 1024});
  const ev = [];
  await new Promise((resolve) => {
    s.on('error', (e) => ev.push(`error:${e.code}`));
    s.on('close', () => { ev.push('close'); resolve(); });
    s.once('data', () => { ev.push('data'); h.close().catch((e) => ev.push(`close-error:${e.code}`)); });
  });
  return {output: {how: input.how, detail: ev.join(',')}};
};
