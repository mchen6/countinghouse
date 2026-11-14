// The main thread's side of a module worker's output and log (the review of
// #186, lib/worker-output.js): lines cut at 8 KiB and stripped of control
// characters, a per-minute byte budget that counts what it drops (and what
// the worker says it dropped) and says it once, and log records named by the
// main thread with their fields cut. Server-free.
const assert = require('assert');
const out = require('../../lib/worker-output');
const LOG = require('../../lib/logger');
const path = require('path');
const {Worker} = require('worker_threads');

describe('module-loading 29: a module worker\'s output and log, bounded on the main thread', () => {
  it('lines: split on \\n across pushes, control characters but \\t removed, a long line cut once with "…"', () => {
    const s = new out.LineSplitter();
    assert.deepStrictEqual(s.push('a\x1b[31mb\tc\x07\nhal'), ['a[31mb\tc']);
    assert.deepStrictEqual(s.push('f\r\x9b2J\n\n'), ['half2J', '']);
    const long = s.push(`${'é'.repeat(5000)}${'z'.repeat(100)}\nnext\n`);
    assert.strictEqual(long.length, 2);
    assert.ok(long[0].endsWith('…') && Buffer.byteLength(long[0]) <= out.LINE_MAX, `${Buffer.byteLength(long[0])}`);
    assert.ok(!long[0].includes('�'), 'no character split');
    assert.strictEqual(long[1], 'next');
    assert.deepStrictEqual(s.push('tail'), []);
    assert.deepStrictEqual(s.end(), ['tail']);
  });

  it('a budget: past its limit dropped and counted, with the worker\'s own count, said once when the window ends', () => {
    let t = 0;
    const b = new out.Budget(100, () => t);
    const said = [];
    b.onDropped = (d) => said.push(d);
    assert.strictEqual(b.take(60), true);
    assert.strictEqual(b.take(60), false);
    b.drop(1000);
    t = out.WINDOW_MS - 1;
    b.roll();
    assert.deepStrictEqual(said, []);
    t = out.WINDOW_MS;
    assert.strictEqual(b.take(60), true, 'a new window');
    assert.deepStrictEqual(said, [{bytes: 1060, items: 2}]);
    b.roll(true);
    assert.strictEqual(said.length, 1, 'nothing dropped, nothing said');
  });

  it('output: each line named by the main thread; under --stdio both streams go to stderr', () => {
    const written = [];
    out.setSink((stream, line) => written.push([stream, line]));
    const wm = {hostModuleName: 'mod-a'};
    out.onOutput(wm, 'stdout', {text: 'one\ntw'});
    out.onOutput(wm, 'stdout', {text: 'o\n'});
    out.onOutput(wm, 'stderr', {text: 'err\n'});
    out.onOutput(wm, 'stdout', {dropped: 5000});
    out.end(wm);
    assert.deepStrictEqual(written, [['stdout', 'mod-a: one'], ['stdout', 'mod-a: two'], ['stderr', 'mod-a: err'], ['stdout', 'mod-a: 5000 bytes of stdout dropped']]);
  });

  it('log: the main thread\'s name for the module, never the record\'s; fields cut; past 1 MiB dropped and summed up once', () => {
    const saved = {logger: LOG.logger, W: LOG.W};
    const records = [];
    const warned = [];
    LOG.logger = {info: (rec, msg) => records.push({rec, msg}), warn: (rec, msg) => records.push({rec, msg}), error: (rec, msg) => records.push({rec, msg})};
    LOG.W = (line) => warned.push(line);
    try {
      const wm = {hostModuleName: 'mod-a'};
      out.onLog(wm, {level: 30, msg: 'hello', module: 'someone-else', name: 'forged'});
      out.onLog(wm, {level: 50, msg: 'x'.repeat(20000), e: 'boom'});
      assert.deepStrictEqual(records[0], {rec: {module: 'mod-a'}, msg: 'hello'});
      assert.ok(records[1].msg.endsWith('…') && Buffer.byteLength(records[1].msg) <= out.FIELD_MAX);
      assert.strictEqual(records[1].rec.e, 'boom');
      for (let i = 0; i < 300; i++) out.onLog(wm, {level: 30, msg: 'y'.repeat(4096)});
      assert.ok(records.length < 300, `${records.length} written`);
      out.end(wm);
      assert.strictEqual(warned.length, 1);
      assert.match(warned[0], /^mod-a: \d+ log records \(\d+ bytes\) dropped$/);
    } finally {
      Object.assign(LOG, saved);
    }
  });

  it('worker side: process.stdout, stderr and console write to the module streams; a write Node acknowledges after the swap does not crash the worker', async () => {
    const lib = path.join(__dirname, '..', '..', 'lib');
    const w = new Worker(`
      const {parentPort} = require('worker_threads');
      console.log('before the swap, on Node\\'s own stdout');
      const sent = [];
      const {installModuleStdio} = require(${JSON.stringify(path.join(lib, 'worker-stdio'))});
      const streams = installModuleStdio({send: (stream, data) => sent.push([stream, data])});
      console.log('via console');
      process.stderr.write('via stderr\\n');
      process._rawDebug('via rawDebug');
      process.stdout.write('é', 'latin1');
      process.stdout.write('6869', 'hex');
      process.stdout.write('a'.repeat(65535) + '\\u{1F600}' + 'b');
      setTimeout(() => parentPort.postMessage({sent, same: process.stdout === streams.stdout && console._stdout === streams.stdout,
        configurable: Object.getOwnPropertyDescriptor(process, 'stdout').configurable}), 200);`, {eval: true, stdout: true});
    const got = await new Promise((resolve, reject) => { w.once('message', resolve); w.once('error', reject); });
    await w.terminate();
    assert.strictEqual(got.same, true);
    assert.strictEqual(got.configurable, false);
    assert.deepStrictEqual(got.sent.filter((x) => x[0] === 'stderr'), [['stderr', {text: 'via stderr\nvia rawDebug\n'}]]);
    const pieces = got.sent.filter((x) => x[0] === 'stdout').map((x) => x[1].text);
    assert.ok(pieces.every((p) => !/[\uD800-\uDBFF]$/.test(p)), 'no piece ends inside a surrogate pair');
    assert.strictEqual(pieces.join(''), `via console\néhi${'a'.repeat(65535)}\u{1F600}b`);
  });

  it('a device error\'s field arrives serialized and stays as it is; an unknown level is info, 60 is fatal', () => {
    assert.strictEqual(LOG.deviceErrorSerializer('dev: broke'), 'dev: broke');
    const saved = LOG.logger;
    const calls = [];
    LOG.logger = {info: (r) => calls.push(['info', r]), fatal: (r) => calls.push(['fatal', r]), error: () => {}, warn: () => {}};
    try {
      const wm = {hostModuleName: 'mod-b'};
      out.onLog(wm, {level: 'constructor', msg: 'x'});
      out.onLog(wm, {level: 60, msg: 'y', de: 'dev: broke'});
      assert.deepStrictEqual(calls.map((c) => c[0]), ['info', 'fatal']);
      assert.strictEqual(calls[1][1].de, 'dev: broke');
      out.end(wm);
    } finally {
      LOG.logger = saved;
    }
  });

  it('output dropped mid-line ends the line there: nothing after the gap is glued to it', () => {
    const written = [];
    out.setSink((stream, line) => written.push(line));
    const wm = {hostModuleName: 'mod-c'};
    out.onOutput(wm, 'stdout', {text: 'progress 10%'});
    out.onOutput(wm, 'stdout', {text: `\n${'z'.repeat(out.STREAM_BUDGET)}\n`});
    out.onOutput(wm, 'stdout', {text: 'later\n'});
    assert.deepStrictEqual(written, ['mod-c: progress 10%', 'mod-c: later']);
    out.end(wm);
  });
});
