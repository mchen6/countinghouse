// The /code-review medium findings on #59 (reviewer-confirmed, 2026-11-11):
// memory is bounded and finished calls are released; a report reads only the
// day directories its window needs; Out records carry the module; a non-admin
// with no caller id sees nothing; the receipt survives a result with no
// content array; the operator CLI refuses a usage directory that does not
// exist; and an HTTP invoke-action caller's usageCall never reaches the
// invoke args.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');
const {createUsage} = require('../../lib/usage');
const {usageReport} = require('../../lib/usage/report');
const {readUsage} = require('../../lib/usage/read');
const {finishToolCall} = require('../../lib/usage/receipt');

const NOW = Date.parse('2026-11-11T13:00:00.000Z');

describe('usage: the review fixes of #59', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-usage-fix-')); });
  afterEach(() => { fs.rmSync(dir, {recursive: true, force: true}); });
  const clock = () => { let t = NOW - 60000; return () => t++; };

  it('a finished call is released, and memory keeps at most memoryMax records', () => {
    const u = createUsage({usageDir: null, pid: 1, startMs: 1, now: clock(), memoryMax: 3});
    for (let i = 0; i < 5; i++) {
      const call = u.beginCall({pack: null, module: 'm', tool: 't', caller: 'u_a'});
      u.recordIn(call, {server: 's', tool: 'x', bytes: 1, lines: 1, ms: 1, outcome: 'ok', credential: null});
      const receipt = u.recordOut(call, {tool: 't', bytes: 2, lines: 1, ms: 1, outcome: 'ok'});
      assert.strictEqual(receipt.calls, 1);
      assert.match(u.receiptSentenceOf(call), /^read 1 line/, 'the sentence is still there right after the Out record');
    }
    assert.strictEqual(u.inFlight(), 0, 'no finished call is kept open');
    assert.strictEqual(u.records().length, 3);
    assert.strictEqual(u.records()[2].call, 5, 'the newest are kept');
  });

  it('a recorder that writes files makes the report read them, its own process included, not memory', () => {
    const u = createUsage({usageDir: dir, pid: 2, startMs: 2, now: clock(), memoryMax: 1});
    for (let i = 0; i < 3; i++) {
      const call = u.beginCall({pack: null, module: 'm', tool: 't', caller: 'u_a'});
      u.recordOut(call, {tool: 't', bytes: 2, lines: 1, ms: 1, outcome: 'ok'});
    }
    const out = usageReport({}, {caller: 'u_a', isAdmin: false}, {usage: u, usageDir: dir, now: () => NOW});
    assert.deepStrictEqual(out.source, ['files']);
    assert.strictEqual(out.totals.calls, 3, 'records memory let go of are still in the file');
  });

  it('the reader skips the day directories before since without reading them', () => {
    for (const day of ['2026-11-01', '2026-11-11']) {
      fs.mkdirSync(path.join(dir, day));
      fs.writeFileSync(path.join(dir, day, '1-1.jsonl'), `${JSON.stringify({t: `${day}T10:00:00.000Z`, call: 1, tool: 't', bytesOut: 1, linesOut: 1, ms: 1, outcome: 'ok', caller: 'u_a'})}\n`);
    }
    const read = [];
    const original = fs.readFileSync;
    fs.readFileSync = function(p, ...rest) { read.push(String(p)); return original.call(this, p, ...rest); };
    try {
      assert.strictEqual(readUsage(dir, {since: '2026-11-10'}).length, 1);
      assert.strictEqual(usageReport({since: '2026-11-10'}, {caller: null, isAdmin: true}, {usage: null, usageDir: dir, now: () => NOW}).totals.calls, 1);
    } finally {
      fs.readFileSync = original;
    }
    assert.ok(read.length > 0 && read.every((p) => !p.includes('2026-11-01')), read.join(', '));
  });

  it('a direct call to a plain module is grouped under that module, not (unknown)', () => {
    const u = createUsage({usageDir: null, pid: 3, startMs: 3, now: clock()});
    const call = u.beginCall({pack: null, module: 'log-read', tool: 'log_read_svc_get', caller: 'u_a'});
    u.recordOut(call, {tool: 'log_read_svc_get', bytes: 2, lines: 1, ms: 1, outcome: 'ok'});
    assert.strictEqual(u.records()[0].module, 'log-read');
    const out = usageReport({groupBy: 'module'}, {caller: 'u_a', isAdmin: false}, {usage: u, usageDir: null, now: () => NOW});
    assert.deepStrictEqual(out.groups.map((g) => [g.module, g.calls]), [['log-read', 1]]);
  });

  it('a non-admin with no caller id sees nothing, not every other caller without one', () => {
    const u = createUsage({usageDir: null, pid: 4, startMs: 4, now: clock()});
    const call = u.beginCall({pack: null, module: 'm', tool: 't', caller: null});
    u.recordOut(call, {tool: 't', bytes: 2, lines: 1, ms: 1, outcome: 'ok'});
    const out = usageReport({}, {caller: null, isAdmin: false}, {usage: u, usageDir: null, now: () => NOW});
    assert.deepStrictEqual([out.groups, out.totals.calls], [[], 0]);
  });

  it('a scenario result with no content array still gets its receipt', () => {
    const u = createUsage({usageDir: null, pid: 5, startMs: 5, now: clock()});
    const call = u.beginCall({pack: 'p', module: 'p', tool: 't', caller: 'u_a'});
    const r = finishToolCall({usage: u, call, result: {isError: false}, role: 'scenario', tool: 't', startedMs: NOW, now: () => NOW});
    assert.strictEqual(r.content.length, 1);
    assert.match(r.content[0].text, /^no server was called; 0 lines \(0 B\) reached the model\.$/);
    assert.ok(r._meta['countinghouse/receipt'] != null);
  });

  it('countinghouse-usage refuses a usage directory that does not exist', () => {
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', '..', 'bin', 'countinghouse-usage.js'), '--usageDir', path.join(dir, 'usgae')], {encoding: 'utf8', timeout: 20000});
    assert.strictEqual(r.status, 2);
    assert.match(r.stderr, /no usage directory at .*usgae/);
  });

  it('an HTTP invoke-action caller\'s usageCall never reaches the invoke args', (done) => {
    const options = require('../../lib/cli-options');
    options.setOptions({redisUrl: 'redis://127.0.0.1:9749'});
    require('../../lib/logger').createLogger(false);
    const invokeAction = require('../../lib/routes/invoke-action');
    const seen = [];
    const cdif = {
      deviceManager: {deviceMap: {}, moduleManager: null},
      invokeDeviceAction: (deviceID, serviceID, actionName, args) => { seen.push(args); finish(); }
    };
    const router = invokeAction(null, cdif);
    const session = {callbackWithoutTimer: (err) => { seen.push({err}); finish(); }};
    const req = {method: 'POST', url: '/', params: {deviceID: 'd1'}, headers: {'content-type': 'application/json'}, session,
      body: {serviceID: 's', actionName: 'a', input: {v: 1}, usageCall: 99999, usagecall: 99998}};
    function finish() {
      try {
        assert.strictEqual(seen.length, 1);
        assert.deepStrictEqual(Object.keys(seen[0]).sort(), ['ctx', 'httpHeaders', 'input']);
        assert.deepStrictEqual(seen[0].input, {v: 1});
        done();
      } catch (e) { done(e); }
    }
    router.handle(req, {}, (err) => done(err || new Error('the route did not handle the request')));
  });
});
