// A module worker's output and log, bounded (the review of #186 and of #190):
// lines cut at 8 KiB and stripped of control characters, line separators and
// bidi controls; each line charged what writing it costs, in the worker and
// again on the main thread, so a flood of empty lines writes at most the
// budget; output and records that could not be sent are counted, never lost
// silently; log records named by the main thread and charged a minimum each.
// Server-free.
const assert = require('assert');
const path = require('path');
const {Worker} = require('worker_threads');
const out = require('../../lib/worker-output');
const lines = require('../../lib/output-lines');
const limits = require('../../lib/output-limits');
const envelope = require('../../lib/message-envelope');
const LOG = require('../../lib/logger');

const LIB = path.join(__dirname, '..', '..', 'lib');

describe('module-loading 29: a module worker\'s output and log, bounded', () => {
  it('lines: split on \\n across pushes; control characters, line separators and bidi controls removed, \\t kept; a long line cut once', () => {
    const s = new lines.LineSplitter();
    assert.deepStrictEqual(s.push('a\x1b[31mb\tc\x07\nhal'), ['a[31mb\tc']);
    assert.deepStrictEqual(s.push('f\r\x9b2J\u2028x\u2029y\u202ez\u2066w\n\n'), ['half2Jxyzw', '']);
    const long = s.push(`${'é'.repeat(5000)}${'z'.repeat(100)}\nnext\n`);
    assert.strictEqual(long.length, 2);
    assert.ok(long[0].endsWith('…') && Buffer.byteLength(long[0]) <= limits.LINE_MAX, `${Buffer.byteLength(long[0])}`);
    assert.ok(!long[0].includes('\uFFFD'), 'no character split');
    assert.strictEqual(long[1], 'next');
    assert.deepStrictEqual(s.push('tail'), []);
    assert.deepStrictEqual(s.end(), ['tail']);
    assert.strictEqual(lines.cleanField('a\nb\u202ec\x1b'), 'a\nbc', 'a log field keeps \\n');
    // the gate's subset of the one class (lib/module-text.js): the bidi marks
    // go too, a tab stays, an emoji sequence stays whole
    assert.strictEqual(lines.cleanField('a\u200eb\u200fc\u061cd\te'), 'abcd\te');
    assert.strictEqual(lines.lineOf('\u{1f468}\u200d\u{1f469} \u2764\ufe0f'), '\u{1f468}\u200d\u{1f469} \u2764\ufe0f');
  });

  it('a budget: past its limit dropped and counted, said once when the window ends', () => {
    let t = 0;
    const b = new lines.Budget(100, () => t);
    const said = [];
    b.onDropped = (d) => said.push(d);
    assert.strictEqual(b.take(60), true);
    assert.strictEqual(b.take(60), false);
    b.drop(1000, 0);
    t = limits.WINDOW_MS - 1;
    b.roll();
    assert.deepStrictEqual(said, []);
    t = limits.WINDOW_MS;
    assert.strictEqual(b.take(60), true, 'a new window');
    assert.deepStrictEqual(said, [{bytes: 1060, items: 1}]);
    b.roll(true);
    assert.strictEqual(said.length, 1, 'nothing dropped, nothing said');
  });

  it('main thread: each line named and charged prefix + bytes + newline; a flood of empty lines writes at most the backstop', () => {
    const written = [];
    out.setSink((stream, line) => written.push([stream, line]));
    const wm = {hostModuleName: 'mod-a'};
    out.onOutput(wm, 'stdout', {lines: ['one', 'two\x1b[0m']});
    out.onOutput(wm, 'stderr', {lines: ['err']});
    assert.deepStrictEqual(written, [['stdout', 'mod-a: one'], ['stdout', 'mod-a: two[0m'], ['stderr', 'mod-a: err']]);
    written.length = 0;
    for (let i = 0; i < 200; i++) out.onOutput(wm, 'stdout', {lines: new Array(1000).fill('')});
    const bytes = written.reduce((n, [, l]) => n + Buffer.byteLength(l) + 1, 0);
    // a worker that ignores its own budget (an honest one stays within STREAM_BUDGET)
    assert.ok(bytes <= limits.STREAM_BACKSTOP, `${bytes} bytes written`);
    assert.ok(bytes > limits.STREAM_BACKSTOP - 64, `${bytes} bytes written`);
    written.length = 0;
    out.onOutput(wm, 'stdout', {dropped: 5000});
    out.end(wm);
    assert.strictEqual(written.length, 1);
    assert.match(written[0][1], /^mod-a: \d+ bytes of stdout dropped$/);
    assert.ok(Number(written[0][1].match(/(\d+) bytes/)[1]) > 5000);
  });

  it('main thread: anything but a list of strings is not output, and is counted', () => {
    const written = [];
    out.setSink((stream, line) => written.push(line));
    const wm = {hostModuleName: 'mod-x'};
    for (const data of [{text: 'old shape\n'}, {lines: 'x'}, {lines: ['ok', 1]}, {lines: new Array(limits.BATCH_UNITS + 1).fill('a')}]) out.onOutput(wm, 'stdout', data);
    out.end(wm);
    assert.deepStrictEqual(written, ['mod-x: 3 bytes of stdout dropped']);
  });

  it('main thread: a message past --moduleMessageRate is counted at its lines\' cost, without writing them', () => {
    const written = [];
    out.setSink((stream, line) => written.push(line));
    const wm = {hostModuleName: 'mod-r'};
    out.onRateDropped(wm, 'stdout', {lines: ['abc', '']});
    out.end(wm);
    assert.deepStrictEqual(written, [`mod-r: ${2 * Buffer.byteLength('mod-r: ') + 3 + 2} bytes of stdout dropped`]);
  });

  it('log: named by the main thread, fields cut and cleaned; each record costs at least 256 bytes; lost records counted', () => {
    const saved = {logger: LOG.logger, W: LOG.W};
    const records = [];
    const warned = [];
    const keep = (level) => (rec, msg) => records.push({level, rec, msg});
    LOG.logger = {info: keep('info'), warn: keep('warn'), error: keep('error'), fatal: keep('fatal')};
    LOG.W = (line) => warned.push(line);
    try {
      const wm = {hostModuleName: 'mod-a'};
      out.onLog(wm, {level: 30, msg: 'hello\u202e', module: 'someone-else'});
      out.onLog(wm, {level: 50, msg: 'x'.repeat(20000), e: 'boom\nat line 2'});
      out.onLog(wm, {level: 'constructor', msg: 'odd level'});
      out.onLog(wm, {level: 60, msg: 'y', de: 'dev: broke'});
      assert.deepStrictEqual(records[0], {level: 'info', rec: {module: 'mod-a'}, msg: 'hello'});
      assert.ok(records[1].msg.endsWith('…') && Buffer.byteLength(records[1].msg) <= limits.FIELD_MAX);
      assert.strictEqual(records[1].rec.e, 'boom\nat line 2');
      assert.deepStrictEqual([records[2].level, records[3].level, records[3].rec.de], ['info', 'fatal', 'dev: broke']);
      assert.strictEqual(LOG.deviceErrorSerializer('dev: broke'), 'dev: broke');
      records.length = 0;
      for (let i = 0; i < 10000; i++) out.onLog(wm, {level: 30});
      assert.ok(records.length <= limits.LOG_BUDGET / limits.RECORD_MIN, `${records.length} empty records written`);
      out.onLog(wm, {level: 30, msg: 'z', lost: 7});
      const before = records.length;
      out.onLog(wm, {level: 30, lost: 5});
      out.onLog(wm, {level: 30, lost: 2 ** 52});
      assert.strictEqual(records.length, before, 'a count alone writes nothing');
      out.end(wm);
      assert.strictEqual(warned.length, 1);
      const m = warned[0].match(/^mod-a: (\d+) log records \((\d+) bytes\) dropped$/);
      assert.ok(m != null && Number(m[1]) > 12 && Number.isSafeInteger(Number(m[2])), warned[0]);
    } finally {
      Object.assign(LOG, saved);
    }
  });

  it('every batch the worker sends fits the envelope at the smallest --maxOutputBytes, as the envelope measures it on this Node; none is dropped for its size', async () => {
    const w = new Worker(`
      const {parentPort} = require('worker_threads');
      const env = require(${JSON.stringify(path.join(LIB, 'message-envelope'))});
      const cap = env.capFor(1);
      const {installModuleStdio} = require(${JSON.stringify(path.join(LIB, 'worker-stdio'))});
      let lines = 0;
      let refused = 0;
      let dropped = 0;
      let biggest = 0;
      installModuleStdio('m', {send: (stream, data) => {
        try {
          const b = env.wrap({id: stream, category: 'child', command: stream, errMsg: null, data}, cap).envelope.b.byteLength;
          biggest = Math.max(biggest, b);
          if (data.lines) lines += data.lines.length;
          if (data.dropped) dropped += data.dropped;
          return true;
        } catch (e) {
          refused += 1;
          return e.code === 'MESSAGE_TOO_LARGE' ? 'too-large' : false;
        }
      }});
      // within the budget: empty lines, and long lines of two-byte characters
      process.stdout.write('\\n'.repeat(15000));
      process.stderr.write(('\\u4e00'.repeat(2700) + '\\n').repeat(30));
      setTimeout(() => parentPort.postMessage({lines, refused, dropped, biggest, cap}), 300);`, {eval: true});
    const got = await new Promise((resolve, reject) => { w.once('message', resolve); w.once('error', reject); });
    await w.terminate();
    assert.strictEqual(got.lines, 15030, JSON.stringify(got));
    assert.strictEqual(got.dropped, 0, JSON.stringify(got));
    assert.ok(got.biggest <= got.cap, JSON.stringify(got));
  });

  it('a log record of three full fields fits the envelope at the smallest --maxOutputBytes', () => {
    const cap = envelope.capFor(1);
    const record = {level: 50, msg: '\u4e00'.repeat(limits.FIELD_MAX), e: '\u4e00'.repeat(limits.FIELD_MAX), de: '\u4e00'.repeat(limits.FIELD_MAX), lost: 3};
    assert.doesNotThrow(() => envelope.wrap({id: 'log', category: 'child', command: 'log', errMsg: null, data: record}, cap));
  });

  it('worker side: getters, console and _rawDebug write lines; empty lines are charged as written; a batch that cannot be sent is counted', async () => {
    const w = new Worker(`
      const {parentPort} = require('worker_threads');
      console.log('before the swap, on Node\\'s own stdout');
      const sent = [];
      let failNext = false;
      const {installModuleStdio} = require(${JSON.stringify(path.join(LIB, 'worker-stdio'))});
      const streams = installModuleStdio('mod-w', {send: (stream, data) => {
        if (failNext && data.lines) { failNext = false; return false; }
        sent.push([stream, data]);
        return true;
      }});
      console.log('via console');
      process.stderr.write('via stderr\\n');
      process._rawDebug('via rawDebug');
      process.stdout.write('é', 'latin1');
      process.stdout.write('6869', 'hex');
      process.stdout.write('\\n');
      process.stdout.write('unfinished');
      setTimeout(() => {
        const before = sent.length;
        failNext = true;
        process.stdout.write('lost line\\n');
        setTimeout(() => {
          process.stdout.write('\\n'.repeat(300000));
          setTimeout(() => parentPort.postMessage({sent, before, same: process.stdout === streams.stdout && console._stdout === streams.stdout,
            configurable: Object.getOwnPropertyDescriptor(process, 'stdout').configurable}), 1300);
        }, 50);
      }, 50);`, {eval: true, stdout: true});
    const got = await new Promise((resolve, reject) => { w.once('message', resolve); w.once('error', reject); });
    await w.terminate();
    assert.strictEqual(got.same, true);
    assert.strictEqual(got.configurable, false);
    const first = got.sent.slice(0, got.before);
    assert.deepStrictEqual(first.filter((x) => x[0] === 'stderr').flatMap((x) => x[1].lines), ['via stderr', 'via rawDebug']);
    assert.deepStrictEqual(first.filter((x) => x[0] === 'stdout').flatMap((x) => x[1].lines), ['via console', 'éhi']);
    // the unfinished line was ended by the next write's newline ('lost line' failed to send with it)
    const later = got.sent.slice(got.before);
    const prefix = Buffer.byteLength('mod-w: ');
    const charged = later.filter((x) => x[1].lines).flatMap((x) => x[1].lines).reduce((n, l) => n + prefix + Buffer.byteLength(l) + 1, 0);
    assert.ok(charged <= limits.STREAM_BUDGET, `${charged} bytes sent`);
    const dropped = later.filter((x) => x[1].dropped != null).reduce((n, x) => n + x[1].dropped, 0);
    // the lost line, and the empty lines past the budget, each at what writing it costs
    assert.ok(dropped >= (prefix + 'lost line'.length + 1) + (300000 * (prefix + 1) - limits.STREAM_BUDGET), `${dropped} dropped`);
  });

  // The cleaning runs on the built-ins lib/module-text.js took at load: a
  // module that patches them afterwards (every method the rule uses, made to
  // fail open) still gets no control or bidi character into its own lines
  // (the Reviewer, the fold after #445).
  it('worker side: a module patching the built-ins after load gets no control or bidi character into its lines', async () => {
    const w = new Worker(`
      const {parentPort} = require('worker_threads');
      const sent = [];
      const {installModuleStdio} = require(${JSON.stringify(path.join(LIB, 'worker-stdio'))});
      installModuleStdio('mod-p', {send: (stream, data) => { if (data.lines) sent.push(...data.lines); return true; }});
      // the module's own code, after the runtime's load
      RegExp.prototype.test = function() { return false; };
      RegExp.prototype.exec = function() { return null; };
      RegExp.prototype[Symbol.replace] = function(s) { return String(s); };
      String.prototype.replace = function() { return String(this); };
      String.prototype.codePointAt = function() { return 0x41; };
      Set.prototype.has = function() { return true; };
      Array.from = (x) => x;
      process.stdout.write('evil\\x1b[2J\\u202e\\u2066\\u200f\\x9b2Jend\\n');
      setTimeout(() => parentPort.postMessage(sent), 300);`, {eval: true, stdout: true});
    const got = await new Promise((resolve, reject) => { w.once('message', resolve); w.once('error', reject); });
    await w.terminate();
    assert.ok(got.length >= 1 && got.some((l) => /evil/.test(l) && /end/.test(l)), JSON.stringify(got));
    for (const l of got) assert.doesNotMatch(l, /[\x00-\x08\x0a-\x1f\x7f-\x9f\u2028-\u202e\u2066-\u2069\u200e\u200f\u061c]/, JSON.stringify(l));
  });

  it('worker side: an unfinished line goes as a line before the runtime\'s reply, never held back', async () => {
    const w = new Worker(`
      const {parentPort} = require('worker_threads');
      const sent = [];
      const WorkerMessage = require(${JSON.stringify(path.join(LIB, 'worker-message'))});
      const {installModuleStdio} = require(${JSON.stringify(path.join(LIB, 'worker-stdio'))});
      installModuleStdio('mod-p', {send: (stream, data) => { sent.push([stream, data]); return true; }});
      process.stdout.write('result: 42');
      new WorkerMessage(null).sendMessageToParent(1, null, {done: true});
      parentPort.postMessage({sent});`, {eval: true});
    const got = await new Promise((resolve, reject) => {
      w.on('message', (m) => { if (m != null && Array.isArray(m.sent)) resolve(m); });
      w.once('error', reject);
    });
    await w.terminate();
    assert.deepStrictEqual(got.sent, [['stdout', {lines: ['result: 42']}]]);
  });
});
