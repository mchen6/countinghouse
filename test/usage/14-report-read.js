// The usage report's read path (review of #158): records are filtered by
// caller and window while each line is read, before JSON.parse where a cheap
// check can tell, so a plain key never pays to parse every tenant's records;
// files are streamed, not read whole; a record's `t` must be an ISO-8601 UTC
// time; an out-of-range duration is a plain refusal; a plain caller's default
// window is the last 31 days (since "all" for everything); the kept-out
// estimate is rounded per tool call, so the day rows add up to the total.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {normalise} = require('../../lib/usage/read');
const {usageReport, OUTPUT_SCHEMA, KEPT_OUT_METHOD} = require('../../lib/usage/report');
const Ajv2020 = require('ajv/dist/2020');

const NOW = Date.parse('2026-11-14T12:00:00.000Z');
const DAY = 86400000;
const ADMIN = {caller: 'u_admin', isAdmin: true};
const PLAIN = {caller: 'u_a', isAdmin: false};

const result = (t, caller, call = 1) => ({t, call, pack: 'p', tool: 'x', bytesOut: 4, linesOut: 1, ms: 2, outcome: 'ok', caller});
const iso = (msBack) => new Date(NOW - msBack).toISOString();

// A usage directory: { 'YYYY-MM-DD': [record or raw line, ...] }, one file per day.
function usageDir(days) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-usage-read-'));
  for (const [day, lines] of Object.entries(days)) {
    fs.mkdirSync(path.join(dir, day), {recursive: true});
    fs.writeFileSync(path.join(dir, day, '7-1.jsonl'), `${lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n')}\n`);
  }
  return dir;
}
const report = (dir, args, who) => usageReport(args, who, {usage: null, usageDir: dir, now: () => NOW});

describe('the usage report\'s read path', () => {
  let dir = null;
  afterEach(() => { if (dir != null) fs.rmSync(dir, {recursive: true, force: true}); dir = null; });

  it('is asynchronous, and streams the files rather than reading them whole', async () => {
    dir = usageDir({'2026-11-13': [result('2026-11-13T10:00:00.000Z', 'u_a')]});
    const readFileSync = fs.readFileSync;
    fs.readFileSync = function(p, ...rest) {
      if (String(p).endsWith('.jsonl')) throw new Error('read whole');
      return readFileSync.call(this, p, ...rest);
    };
    try {
      const pending = report(dir, {since: 'all'}, ADMIN);
      assert.ok(pending instanceof Promise);
      assert.strictEqual((await pending).totals.calls, 1);
    } finally {
      fs.readFileSync = readFileSync;
    }
  });

  it('a plain caller\'s report parses only its own lines, and only those in the window', async () => {
    const day = '2026-11-13';
    const lines = [];
    for (let i = 0; i < 90; i++) lines.push(result(`${day}T10:00:${String(i % 60).padStart(2, '0')}.000Z`, 'u_b', i));
    for (let i = 0; i < 10; i++) lines.push(result(`${day}T11:00:${String(i).padStart(2, '0')}.000Z`, 'u_a', 100 + i));
    for (let i = 0; i < 20; i++) lines.push(result(`${day}T01:00:${String(i).padStart(2, '0')}.000Z`, 'u_a', 200 + i));   // before since
    dir = usageDir({[day]: lines});
    const parse = JSON.parse;
    let parsed = 0;
    JSON.parse = function(...a) { parsed += 1; return parse.apply(this, a); };
    let out;
    try {
      out = await report(dir, {since: `${day}T10:30:00Z`}, PLAIN);
    } finally {
      JSON.parse = parse;
    }
    assert.strictEqual(out.totals.calls, 10);
    assert.ok(parsed <= 10, `${parsed} lines parsed`);
  });

  it('a line naming the caller only in a value is checked after it is parsed', async () => {
    dir = usageDir({'2026-11-13': [{...result('2026-11-13T10:00:00.000Z', 'u_b'), tool: '"caller":"u_a"'}]});
    assert.strictEqual((await report(dir, {since: 'all'}, PLAIN)).totals.calls, 0);
  });

  it('a record\'s t must be an ISO-8601 UTC time: a corrupted line is skipped, and the report stays valid', async () => {
    for (const t of ['2026-11-13T10:00:00.000Z', '2026-11-13T10:00:00Z']) assert.ok(normalise(result(t, 'u_a')) != null, t);
    for (const t of ['garbage', '2026-11-13', '2026-11-13T10:00:00.000+02:00', '2026-11-13T10:00:00.000', '9999-99-99T99:99:99.999Z', '2026-11-13T10:00:00.000Zjunk']) {
      assert.strictEqual(normalise(result(t, 'u_a')), null, t);
    }
    dir = usageDir({'2026-11-13': [result('2026-11-13T10:00:00.000Z', 'u_a'), result('2026-11-13Tjunk', 'u_a', 2), '{"t":"2026-11-13T10:00:00.000Z","tool"']});
    const out = await report(dir, {since: 'all'}, ADMIN);
    assert.strictEqual(out.totals.calls, 1);
    const ajv = new Ajv2020({strict: false});
    assert.ok(ajv.validate(OUTPUT_SCHEMA, out), JSON.stringify(ajv.errors));
  });

  it('an out-of-range duration or time is a plain refusal, not a RangeError', async () => {
    dir = usageDir({});
    for (const args of [{until: '99999999999d'}, {since: '99999999999d'}, {since: '99999999999999999999m'}, {until: '275761-01-01T00:00:00Z'}]) {
      await assert.rejects(report(dir, args, ADMIN), (e) => !(e instanceof RangeError) && /(since|until) must be/.test(e.message), JSON.stringify(args));
    }
  });

  it('a plain caller\'s default window is the last 31 days; since "all" is everything; an admin\'s default is everything', async () => {
    dir = usageDir({
      [iso(40 * DAY).slice(0, 10)]: [result(iso(40 * DAY), 'u_a')],
      [iso(2 * DAY).slice(0, 10)]: [result(iso(2 * DAY), 'u_a', 2)]
    });
    const plain = await report(dir, {}, PLAIN);
    assert.strictEqual(plain.totals.calls, 1);
    assert.strictEqual(plain.window.since, iso(31 * DAY));
    assert.strictEqual((await report(dir, {since: 'all'}, PLAIN)).totals.calls, 2);
    assert.strictEqual((await report(dir, {}, ADMIN)).totals.calls, 2);
    assert.strictEqual((await report(dir, {}, ADMIN)).window.since, null);
  });

  it('a plain key that names only until gets the 31 days before it, not a refusal', async () => {
    dir = usageDir({'2025-12-20': [result('2025-12-20T10:00:00.000Z', 'u_a')], '2025-10-01': [result('2025-10-01T10:00:00.000Z', 'u_a', 2)]});
    const out = await report(dir, {until: '2025-12-31'}, PLAIN);
    assert.strictEqual(out.window.since, '2025-11-30T23:59:59.999Z');
    assert.strictEqual(out.totals.calls, 1);
  });

  it('an until at the end of year 9999 still reads every record', async () => {
    dir = usageDir({'2026-11-13': [result('2026-11-13T10:00:00.000Z', 'u_a')]});
    assert.strictEqual((await report(dir, {since: 'all', until: '9999-12-31'}, ADMIN)).totals.calls, 1);
  });

  it('a plain key with no calls in the files still has files as a source', async () => {
    dir = usageDir({'2026-11-13': [result('2026-11-13T10:00:00.000Z', 'u_b')]});
    const out = await report(dir, {since: 'all'}, PLAIN);
    assert.deepStrictEqual([out.totals.calls, out.source], [0, ['files']]);
  });

  it('reports run one at a time: a second waits for the first to finish', async () => {
    dir = usageDir({'2026-11-13': [result('2026-11-13T10:00:00.000Z', 'u_a')]});
    const order = [];
    const slow = {records: () => { order.push('first reads'); return []; }, process: 'p'};
    const one = usageReport({since: 'all'}, ADMIN, {usage: slow, usageDir: dir, now: () => NOW}).then(() => order.push('first done'));
    const two = usageReport({since: 'all'}, ADMIN, {usage: {records: () => { order.push('second reads'); return []; }, process: 'p'}, usageDir: dir, now: () => NOW})
      .then(() => order.push('second done'));
    await Promise.all([one, two]);
    assert.deepStrictEqual(order, ['first reads', 'first done', 'second reads', 'second done']);
  });

  it('the estimate is rounded per tool call, and its method says so', () => {
    assert.match(KEPT_OUT_METHOD, /rounded per tool call/);
  });
});
