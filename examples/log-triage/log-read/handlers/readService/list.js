// log-read/list: which log files exist. One hop of the log-triage composite;
// the composite reads the answer to decide how many more hops it will make.
const fs   = require('fs');
const path = require('path');

// log-read's own data directory, where `npm run demo:log-triage` writes the
// sample logs: a module sees its directory as /app and its data as /data,
// in every --moduleSandbox mode (countinghouse 8.0.0), so the demo needs no
// file permission even under enforce.
const DEFAULT_DIR = '/data/sample-logs';

const MAX_FILES = 256;

module.exports = async (input, ctx) => {
  const opts = input || {};

  if (opts.dir != null && (typeof opts.dir !== 'string' || opts.dir === '')) {
    return ctx.error('INPUT_REJECTED', 'dir must be a non-empty string');
  }
  const dir = path.resolve(opts.dir != null ? opts.dir : DEFAULT_DIR);

  let entries;
  try {
    entries = await fs.promises.readdir(dir, {withFileTypes: true});
  } catch (e) {
    return ctx.error('INPUT_REJECTED', `cannot list ${dir}: ${e.code || e.message}`);
  }

  // isFile() on a Dirent is false for a symbolic link, which is the point: a
  // link named x.log is not a log file in this directory.
  const names = entries
    .filter((e) => e.isFile() && e.name.endsWith('.log') && e.name !== '.log')
    .map((e) => e.name)
    .sort()
    .slice(0, MAX_FILES);

  const files = [];
  for (const name of names) {
    const stat = await fs.promises.stat(path.join(dir, name));
    files.push({name: name, bytes: stat.size});
  }

  return {output: {dir: dir, files: files}};
};
