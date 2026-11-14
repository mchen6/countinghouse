// Workload W: a repo walk's shape -- readdir every directory under
// /data/tree and stat every entry, timed inside the handler.
const fs = require('fs');
module.exports = async () => {
  const started = process.hrtime.bigint();
  let entries = 0;
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const p = `${dir}/${name}`;
      const st = fs.statSync(p);
      entries += 1;
      if (st.isDirectory()) walk(p);
    }
  };
  walk('/data/tree');
  return {output: {ms: Number(process.hrtime.bigint() - started) / 1e6, entries}};
};
