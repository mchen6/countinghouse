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
