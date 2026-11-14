// The tree workload W walks: input.dirs directories of input.files small
// files each under /data/tree (made fresh).
const fs = require('fs');
module.exports = async (input) => {
  const started = process.hrtime.bigint();
  fs.rmSync('/data/tree', {recursive: true, force: true});
  for (let d = 0; d < input.dirs; d++) {
    fs.mkdirSync(`/data/tree/d${d}`, {recursive: true});
    for (let f = 0; f < input.files; f++) fs.writeFileSync(`/data/tree/d${d}/f${f}.txt`, 'x');
  }
  return {output: {ms: Number(process.hrtime.bigint() - started) / 1e6, entries: input.dirs * (input.files + 1)}};
};
