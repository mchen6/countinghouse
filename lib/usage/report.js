// countinghouse_usage_report and countinghouse-usage (local-mode spec §5): one
// report from what only the runtime can read safely. Its sources:
//   memory: this process's records (lib/usage), so a call made a second ago
//           is already counted;
//   files:  the usage files of earlier processes under the usage directory
//           (this process's own file is skipped: memory has it).
// Input {since?, groupBy?}. `since` is a day (YYYY-MM-DD), an ISO time, or a
// duration back from now (30m, 24h, 7d); `groupBy` is tool (the default),
// server, pack or module. A plain caller sees only its own calls; an admin
// sees every caller's, grouped by the opaque caller id, never by user name or
// key (R2-1). Tokens are not counted: tokensInEst and tokensOutEst estimate
// them from bytes, and `method` says how. The output is closed (OUTPUT_SCHEMA).
const {readUsage, normalise, DATE} = require('./read');

const METHOD = 'utf8 bytes / 4';
const GROUP_BY = ['tool', 'server', 'pack', 'module'];
const ARGUMENTS = ['since', 'groupBy'];
const DURATION = /^(\d+)(m|h|d)$/;
const UNIT_MS = {m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000};
const UNKNOWN_PACK = '(unknown)';
const NO_RESULT = '(no result recorded)';
const NO_SERVER = '(no server)';
const UNKNOWN_MODULE = '(unknown module)';

const est = (bytes) => Math.round(bytes / 4);

// A real day: Date.UTC would roll 2026-02-30 over to March 2.
function isDay(s) {
  if (!DATE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  return m >= 1 && m <= 12 && d >= 1 && d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// since -> ms since the epoch, or null for "everything"; throws on a bad value.
function sinceMs(since, now) {
  if (since === undefined) return null;
  if (typeof since !== 'string') throw new Error('since must be a day (YYYY-MM-DD), an ISO time, or a duration such as 24h');
  const duration = DURATION.exec(since);
  if (duration) return now - Number(duration[1]) * UNIT_MS[duration[2]];
  if (DATE.test(since)) {
    if (!isDay(since)) throw new Error('since must be a day that exists, YYYY-MM-DD');
    return Date.parse(`${since}T00:00:00.000Z`);
  }
  const t = Date.parse(since);
  if (/^\d{4}-\d\d-\d\dT/.test(since) && Number.isFinite(t)) return t;
  throw new Error('since must be a day (YYYY-MM-DD), an ISO time, or a duration such as 24h');
}

const zero = () => ({calls: 0, serverCalls: 0, bytesIn: 0, linesIn: 0, bytesOut: 0, linesOut: 0});
function add(sum, r) {
  if (r.server === null) sum.calls += 1; else sum.serverCalls += 1;
  sum.bytesIn += r.bytesIn;
  sum.linesIn += r.linesIn;
  sum.bytesOut += r.bytesOut;
  sum.linesOut += r.linesOut;
  return sum;
}
const withEstimates = (s) => ({...s, tokensInEst: est(s.bytesIn), tokensOutEst: est(s.bytesOut)});

// args, the caller ({caller, isAdmin}), and where to read ({usage, usageDir,
// now}) -> the report. Throws an Error with a plain message on a bad argument.
function usageReport(args, {caller, isAdmin}, {usage, usageDir = null, now = Date.now}) {
  const a = args == null ? {} : args;
  for (const k of Object.keys(a)) if (!ARGUMENTS.includes(k)) throw new Error(`unknown argument ${k}: only since and groupBy`);
  const groupBy = a.groupBy === undefined ? 'tool' : a.groupBy;
  if (!GROUP_BY.includes(groupBy)) throw new Error(`groupBy must be one of ${GROUP_BY.join(', ')}`);
  const nowMs = now();
  const from = sinceMs(a.since, nowMs);
  const until = new Date(nowMs).toISOString();
  const fromIso = from == null ? null : new Date(from).toISOString();

  // No recorder (the command line): the files alone.
  const source = usage != null ? ['memory'] : [];
  const memory = usage != null ? usage.records().map((r) => ({...normalise(r), process: usage.process})).filter((r) => r.t != null) : [];
  let files = [];
  if (usageDir != null) {
    files = readUsage(usageDir, {skip: usage != null ? usage.process : undefined});
    if (files.length > 0) source.push('files');
  }
  let records = memory.concat(files).filter((r) => (fromIso == null || r.t >= fromIso) && r.t <= until);
  if (isAdmin !== true) records = records.filter((r) => r.caller === caller);

  // A server call belongs to the tool call with the same `call` in the same process.
  const key = (r) => `${r.process}\u0000${r.call}`;
  const results = new Map(records.filter((r) => r.server === null).map((r) => [key(r), r]));
  const groupOf = (r) => {
    const owner = r.server === null ? r : results.get(key(r));
    if (groupBy === 'tool') return {tool: owner != null ? owner.tool : NO_RESULT};
    if (groupBy === 'pack') return {pack: (owner != null ? owner.pack : r.pack) || UNKNOWN_PACK};
    if (groupBy === 'server') return {server: r.server === null ? NO_SERVER : r.server};
    return {module: r.server === null ? (r.pack || UNKNOWN_PACK) : (typeof r.module === 'string' ? r.module : UNKNOWN_MODULE)};
  };
  const groups = new Map();
  for (const r of records) {
    const g = {...(isAdmin === true ? {caller: typeof r.caller === 'string' ? r.caller : '(unknown)'} : {}), ...groupOf(r)};
    const k = JSON.stringify(g);
    if (!groups.has(k)) groups.set(k, {...g, ...zero()});
    add(groups.get(k), r);
  }
  const activity = (g) => g.calls + g.serverCalls;
  return {
    window: {since: fromIso, until},
    groupBy,
    method: METHOD,
    source,
    groups: [...groups.values()].sort((x, y) => (activity(y) - activity(x)) || JSON.stringify(x).localeCompare(JSON.stringify(y))).map(withEstimates),
    totals: withEstimates(records.reduce(add, zero()))
  };
}

const COUNTS = {
  calls: {type: 'integer', minimum: 0},
  serverCalls: {type: 'integer', minimum: 0},
  bytesIn: {type: 'integer', minimum: 0},
  linesIn: {type: 'integer', minimum: 0},
  bytesOut: {type: 'integer', minimum: 0},
  linesOut: {type: 'integer', minimum: 0},
  tokensInEst: {title: 'an estimate: utf8 bytes / 4', type: 'integer', minimum: 0},
  tokensOutEst: {title: 'an estimate: utf8 bytes / 4', type: 'integer', minimum: 0}
};
const COUNT_NAMES = Object.keys(COUNTS);

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    since: {type: 'string', description: 'a day (YYYY-MM-DD), an ISO time, or a duration back from now (30m, 24h, 7d); absent: everything recorded'},
    groupBy: {type: 'string', enum: GROUP_BY, description: 'what each row counts: a tool (the default), a server, a pack, or a module'}
  },
  additionalProperties: false
};

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    window: {type: 'object', properties: {since: {type: ['string', 'null']}, until: {type: 'string'}}, required: ['since', 'until'], additionalProperties: false},
    groupBy: {type: 'string', enum: GROUP_BY},
    method: {type: 'string', const: METHOD},
    source: {type: 'array', items: {type: 'string', enum: ['memory', 'files', 'metering']}},
    groups: {type: 'array', items: {type: 'object', properties: {
      caller: {title: 'the opaque caller id; admin reports only', type: 'string'},
      tool: {type: 'string'}, server: {type: 'string'}, pack: {type: 'string'}, module: {type: 'string'},
      ...COUNTS}, required: COUNT_NAMES, additionalProperties: false}},
    totals: {type: 'object', properties: COUNTS, required: COUNT_NAMES, additionalProperties: false}
  },
  required: ['window', 'groupBy', 'method', 'source', 'groups', 'totals'],
  additionalProperties: false
};

// The report as text for a person and CSV for a spreadsheet. Exact lines and
// bytes; the token columns are labelled as the estimate they are.
const KEYS = ['caller', 'tool', 'server', 'pack', 'module'];
const CSV_HEADER = 'caller,tool,server,pack,module,calls,server_calls,bytes_in,lines_in,bytes_out,lines_out,tokens_in_est,tokens_out_est';
const n = (x) => x.toLocaleString('en-US');
const cell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

function reportText(r) {
  const head = `usage ${r.window.since == null ? 'since the first record' : `from ${r.window.since}`} to ${r.window.until}, by ${r.groupBy} (sources: ${r.source.join(', ') || 'none'})`;
  if (r.groups.length === 0) return `${head}\nno usage recorded\n`;
  const lines = [head];
  for (const g of r.groups) {
    const label = KEYS.filter((k) => g[k] !== undefined).map((k) => g[k]).join(' ');
    lines.push(`  ${label}: ${n(g.calls)} calls, ${n(g.serverCalls)} server calls; read ${n(g.linesIn)} lines (${n(g.bytesIn)} B), returned ${n(g.linesOut)} lines (${n(g.bytesOut)} B); about ${n(g.tokensInEst)} and ${n(g.tokensOutEst)} tokens, estimate (${r.method})`);
  }
  const t = r.totals;
  lines.push(`total: ${n(t.calls)} calls, ${n(t.serverCalls)} server calls; read ${n(t.linesIn)} lines, returned ${n(t.linesOut)} lines; about ${n(t.tokensInEst)} and ${n(t.tokensOutEst)} tokens, estimate (${r.method})`);
  return `${lines.join('\n')}\n`;
}

function reportCsv(r) {
  const rows = r.groups.map((g) => [...KEYS.map((k) => (g[k] === undefined ? '' : g[k])), g.calls, g.serverCalls, g.bytesIn, g.linesIn, g.bytesOut, g.linesOut, g.tokensInEst, g.tokensOutEst].map(cell).join(','));
  return `${[CSV_HEADER, ...rows].join('\n')}\n`;
}

module.exports = {usageReport, reportText, reportCsv, INPUT_SCHEMA, OUTPUT_SCHEMA, METHOD, CSV_HEADER};
