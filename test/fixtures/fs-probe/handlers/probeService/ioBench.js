// ioBench.js -- input.rounds rounds of: write 4 KB, read it back, stat it,
// unlink it, in /data. For perf/fs-broker-io-perf.js.
const fs = require('fs');
module.exports = async (input) => {
  const buf = Buffer.alloc(4096, 7);
  const started = process.hrtime.bigint();
  for (let i = 0; i < input.rounds; i++) {
    const f = `/data/bench-${i % 8}`;
    fs.writeFileSync(f, buf);
    fs.readFileSync(f);
    fs.statSync(f);
    fs.unlinkSync(f);
  }
  return {output: {ms: Number(process.hrtime.bigint() - started) / 1e6}};
};
