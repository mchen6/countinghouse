// log-read/read: the raw lines of one log file. The only place in the
// log-triage chain where file contents enter the process.
const fs   = require('fs');
const path = require('path');

// examples/log-triage/log-read/handlers/readService/ -> up three.
const DEFAULT_DIR = path.resolve(__dirname, '..', '..', '..', 'sample-logs');

const DEFAULT_MAX_BYTES = 1024 * 1024;
const MAX_MAX_BYTES     = 16 * 1024 * 1024;   // same ceiling as schema.json

// A bare file name: no separator or NUL can appear, so path.join below cannot
// leave the directory. Every name `list` can return (any regular *.log file
// but ".log" itself) is accepted here too.
function isBareLogName(name) {
  return typeof name === 'string' &&
         name.endsWith('.log') && name !== '.log' &&
         !/[/\\\0]/.test(name);
}

module.exports = async (input) => {
  const opts = input || {};

  if (opts.dir != null && (typeof opts.dir !== 'string' || opts.dir === '')) {
    throw new DeviceError('ARGUMENTS_INVALID', 'dir must be a non-empty string');
  }
  if (!isBareLogName(opts.name)) {
    throw new DeviceError('ARGUMENTS_INVALID', 'name must be a bare file name ending in .log');
  }

  const maxBytes = (opts.maxBytes != null) ? opts.maxBytes : DEFAULT_MAX_BYTES;
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new DeviceError('ARGUMENTS_INVALID', `maxBytes must be a positive integer, got ${JSON.stringify(opts.maxBytes)}`);
  }
  if (maxBytes > MAX_MAX_BYTES) {
    throw new DeviceError('ARGUMENTS_INVALID', `maxBytes must be at most ${MAX_MAX_BYTES} (16 MiB), got ${maxBytes}`);
  }

  const dir  = path.resolve(opts.dir != null ? opts.dir : DEFAULT_DIR);
  const full = path.join(dir, opts.name);

  // lstat, not stat: a symbolic link named x.log must be refused, not followed.
  let stat;
  try {
    stat = await fs.promises.lstat(full);
  } catch (e) {
    throw new DeviceError('ARGUMENTS_INVALID', `cannot read ${opts.name}: ${e.code || e.message}`);
  }
  if (!stat.isFile()) {
    throw new DeviceError('ARGUMENTS_INVALID', `${opts.name} is not a regular file`);
  }

  let text;
  let truncated = false;

  if (stat.size <= maxBytes) {
    text = await fs.promises.readFile(full, 'utf8');
  } else {
    const handle = await fs.promises.open(full, 'r');
    try {
      const buffer = Buffer.alloc(maxBytes);
      const {bytesRead} = await handle.read(buffer, 0, maxBytes, 0);
      text = buffer.toString('utf8', 0, bytesRead);
    } finally {
      await handle.close();
    }
    // Cut at the last complete line, so no caller ever sees half a line.
    const cut = text.lastIndexOf('\n');
    text = (cut === -1) ? '' : text.slice(0, cut + 1);
    truncated = true;
  }

  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].endsWith('\r')) lines[i] = lines[i].slice(0, -1);
  }

  return {output: {name: opts.name, bytes: stat.size, lineCount: lines.length, truncated: truncated, lines: lines}};
};
