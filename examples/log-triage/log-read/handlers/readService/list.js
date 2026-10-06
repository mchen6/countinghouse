// log-read/list: which log files exist. One hop of the log-triage composite;
// the composite reads the answer to decide how many more hops it will make.
const fs   = require('fs');
const path = require('path');

// examples/log-triage/log-read/handlers/readService/ -> up three.
const DEFAULT_DIR = path.resolve(__dirname, '..', '..', '..', 'sample-logs');

const MAX_FILES = 256;

module.exports = async (input) => {
  const opts = input || {};

  if (opts.dir != null && (typeof opts.dir !== 'string' || opts.dir === '')) {
    throw new DeviceError('ARGUMENTS_INVALID', 'dir must be a non-empty string');
  }
  const dir = path.resolve(opts.dir != null ? opts.dir : DEFAULT_DIR);

  let entries;
  try {
    entries = await fs.promises.readdir(dir, {withFileTypes: true});
  } catch (e) {
    throw new DeviceError('ARGUMENTS_INVALID', `cannot list ${dir}: ${e.code || e.message}`);
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
