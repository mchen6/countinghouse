// Unit cover for examples/log-triage: the sample-log generator and the three
// leaf handlers, called directly as plain functions -- no server, no Redis.
// The composite is covered end to end by 10-log-triage-example.js.
const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

// Handlers reference the global DeviceError the runtime installs
// (lib/sandbox.js). Outside the runtime it has to be supplied.
if (global.DeviceError == null) {
  global.DeviceError = require('../../lib/countinghouse-error').DeviceError;
}

const EXAMPLE = path.join(__dirname, '..', '..', 'examples', 'log-triage');
const gen     = require(path.join(EXAMPLE, 'generate-logs.js'));

let tmpRoot = null;

before(() => { tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'log-triage-units-')); });
after(() => { fs.rmSync(tmpRoot, {recursive: true, force: true}); });

function readAll(files) {
  return files.map((f) => fs.readFileSync(f, 'utf8')).join('');
}

describe('log-triage units: generate-logs', () => {
  it('writes the requested number of files, named in order, with the requested line count', () => {
    const files = gen.generate({dir: path.join(tmpRoot, 'g1'), files: 3, lines: 50, seed: 1});

    assert.deepStrictEqual(files.map((f) => path.basename(f)), ['app-01.log', 'app-02.log', 'app-03.log']);
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8');
      assert.ok(text.endsWith('\n'));
      assert.strictEqual(text.split('\n').length - 1, 50);
    }
  });

  it('is byte-identical for the same seed and different for another seed', () => {
    const a = readAll(gen.generate({dir: path.join(tmpRoot, 'g2a'), files: 2, lines: 80, seed: 7}));
    const b = readAll(gen.generate({dir: path.join(tmpRoot, 'g2b'), files: 2, lines: 80, seed: 7}));
    const c = readAll(gen.generate({dir: path.join(tmpRoot, 'g2c'), files: 2, lines: 80, seed: 8}));

    assert.strictEqual(a, b);
    assert.notStrictEqual(a, c);
  });

  it('every line is "<ISO timestamp> <LEVEL> <message>"', () => {
    const text = readAll(gen.generate({dir: path.join(tmpRoot, 'g3'), files: 1, lines: 200, seed: 1}));
    const re   = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z (DEBUG|INFO|WARN|ERROR) \S.*$/;

    for (const line of text.split('\n').slice(0, -1)) assert.ok(re.test(line), line);
  });

  it('plants every PII value at the default size', () => {
    const text = readAll(gen.generate({dir: path.join(tmpRoot, 'g4'), files: 8, lines: 400, seed: 1}));

    assert.ok(gen.allPlantedValues().length >= 10);
    for (const value of gen.allPlantedValues()) assert.ok(text.includes(value), `missing ${value}`);
  });
});

describe('log-triage units: log-read', () => {
  const list = require(path.join(EXAMPLE, 'log-read', 'handlers', 'readService', 'list.js'));
  const read = require(path.join(EXAMPLE, 'log-read', 'handlers', 'readService', 'read.js'));

  let dir = null;

  before(() => {
    dir = path.join(tmpRoot, 'read');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'b.log'), 'one\ntwo\nthree\n');
    fs.writeFileSync(path.join(dir, 'a.log'), 'alpha\r\nbeta\r\n');
    fs.writeFileSync(path.join(dir, 'empty.log'), '');
    fs.writeFileSync(path.join(dir, 'no-newline.log'), 'x\ny');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a log');
    fs.mkdirSync(path.join(dir, 'nested.log'));
    fs.writeFileSync(path.join(tmpRoot, 'outside.txt'), 'SECRET OUTSIDE\n');
    fs.symlinkSync(path.join(tmpRoot, 'outside.txt'), path.join(dir, 'link.log'));
  });

  async function rejectsInvalid(promise) {
    await assert.rejects(promise, (err) => err.code === 'ARGUMENTS_INVALID');
  }

  it('list returns only regular *.log files, sorted by name, with sizes', async () => {
    const {output} = await list({dir: dir});

    assert.strictEqual(output.dir, dir);
    assert.deepStrictEqual(output.files, [
      {name: 'a.log', bytes: 13},
      {name: 'b.log', bytes: 14},
      {name: 'empty.log', bytes: 0},
      {name: 'no-newline.log', bytes: 3}
    ]);
  });

  it('list rejects a directory that does not exist', async () => {
    await rejectsInvalid(list({dir: path.join(tmpRoot, 'nope')}));
  });

  it('read returns the lines of one file', async () => {
    const {output} = await read({dir: dir, name: 'b.log'});

    assert.deepStrictEqual(output, {name: 'b.log', bytes: 14, lineCount: 3, truncated: false,
                                    lines: ['one', 'two', 'three']});
  });

  it('read strips the carriage return from CRLF lines', async () => {
    const {output} = await read({dir: dir, name: 'a.log'});
    assert.deepStrictEqual(output.lines, ['alpha', 'beta']);
  });

  it('read handles an empty file and a file with no trailing newline', async () => {
    assert.deepStrictEqual((await read({dir: dir, name: 'empty.log'})).output.lines, []);
    assert.deepStrictEqual((await read({dir: dir, name: 'no-newline.log'})).output.lines, ['x', 'y']);
  });

  it('read stops at the last complete line inside maxBytes and says so', async () => {
    const {output} = await read({dir: dir, name: 'b.log', maxBytes: 9});   // "one\ntwo\nt"

    assert.deepStrictEqual(output.lines, ['one', 'two']);
    assert.strictEqual(output.truncated, true);
    assert.strictEqual(output.bytes, 14);
  });

  it('read rejects any name that is not a bare *.log file name', async () => {
    for (const name of ['../outside.txt', '../read/b.log', 'sub/b.log', 'notes.txt', '.log', '', 'b.log/', 42]) {
      await rejectsInvalid(read({dir: dir, name: name}));
    }
  });

  it('read rejects a symlink and a directory even when they are named *.log', async () => {
    await rejectsInvalid(read({dir: dir, name: 'link.log'}));
    await rejectsInvalid(read({dir: dir, name: 'nested.log'}));
  });

  it('read rejects a non-positive or non-integer maxBytes', async () => {
    await rejectsInvalid(read({dir: dir, name: 'b.log', maxBytes: 0}));
    await rejectsInvalid(read({dir: dir, name: 'b.log', maxBytes: 1.5}));
  });

  it('read accepts every name list returns, including spaces, a leading dot and non-ASCII', async () => {
    const odd = path.join(tmpRoot, 'odd');
    fs.mkdirSync(odd);
    const names = ['my app.log', '.hidden.log', 'caf\u00e9.log'];
    for (const n of names) fs.writeFileSync(path.join(odd, n), `line of ${n}\n`);

    const listed = (await list({dir: odd})).output.files.map((f) => f.name);
    assert.deepStrictEqual(listed, names.slice().sort());

    for (const n of listed) {
      assert.deepStrictEqual((await read({dir: odd, name: n})).output.lines, [`line of ${n}`]);
    }
  });

  it('read rejects a backslash, a NUL and the bare name ".log"', async () => {
    for (const name of ['a\\b.log', 'a\0b.log', '.log']) {
      await rejectsInvalid(read({dir: dir, name: name}));
    }
  });
});
