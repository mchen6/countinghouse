// Workload S: input.writes writes of input.size bytes to one descriptor in
// /data (a logger's or a stream's shape), timed inside the handler.
const fs = require('fs');
module.exports = async (input) => {
  const buf = Buffer.alloc(input.size, 120);
  const started = process.hrtime.bigint();
  const fd = fs.openSync('/data/small-writes.log', 'w');
  try {
    for (let i = 0; i < input.writes; i++) fs.writeSync(fd, buf);
  } finally {
    fs.closeSync(fd);
  }
  return {output: {ms: Number(process.hrtime.bigint() - started) / 1e6, bytes: input.writes * input.size}};
};
