// countinghouse_usage_report and countinghouse-usage (local-mode spec §5): one
// report from what only the runtime can read safely. Its sources:
//   memory: this process's records (lib/usage), so a call made a second ago
//           is already counted;
//   files:  the usage files of earlier processes under the usage directory
//           (this process's own file is skipped: memory has it).
// Input {since?, until?, groupBy?}. `since` is a day (YYYY-MM-DD), an ISO
// time, a duration back from now (30m, 24h, 7d), or "all" (from the first
// record; also what no since means); `until` takes the same forms, a day
// meaning its end, and defaults to now; `groupBy` is tool (the default),
// server, pack or module. A plain caller sees only its own calls; an admin
// sees every caller's, grouped by the opaque caller id, never by user name or
// key (R2-1). Tokens are not counted: tokensInEst and tokensOutEst estimate
// them from bytes, and `method` says how. The output is closed and bounded
// (OUTPUT_SCHEMA).
//
// Part A (Matt, 2026-11-13; #158): the headline is the period's totals; by-day
// rows (at most MAX_DAYS); the tokens kept out of the model's context, an
// upper-bound estimate {estimate, method, bound: "upper"}: per tool call
// max(0, bytes its server calls read - bytes its result returned) / 4. Upper,
// because it takes the model to have read, without the tool, every byte the
// tool read; an agent working directly may have read less. And profiling:
// call time, errors by code, server calls per call. Never "saved" or a cost.
const path = require('path');
const {streamUsage, normalise, DATE} = require('./read');
const {ERROR_CODE} = require('./index');
const {CODES} = require('../error-catalogue');

const METHOD = 'utf8 bytes / 4';
const KEPT_OUT_METHOD = 'utf8 bytes / 4 of max(0, bytes read from servers - bytes returned), rounded per tool call';
const GROUP_BY = ['tool', 'server', 'pack', 'module'];
const ARGUMENTS = ['since', 'until', 'groupBy'];
const MAX_DAYS = 366;
const MAX_GROUPS = 500;
const MAX_CODES = 32;
const MAX_SERVERS = 256;
const MAX_NAME = 256;
// A plain caller's window when it names no since: the last 31 days (since
// "all" for everything). An admin's default is everything (review of #158).
const PLAIN_DEFAULT_DAYS = 31;
// The range a time may take (Date's): past it a duration is refused.
const MAX_TIME_MS = 8.64e15;
const LAST_TIME_MS = Date.parse('9999-12-31T23:59:59.999Z');
// A name from a manifest (a tool, server, pack, module) or a caller id, cut to MAX_NAME.
const cut = (s) => (typeof s === 'string' && s.length > MAX_NAME ? s.slice(0, MAX_NAME) : s);
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

// A time argument -> ms since the epoch; a day is its start (since) or its
// end (until). Throws a plain message on a bad value.
function timeMs(name, value, now, endOfDay) {
  const what = `${name} must be a day (YYYY-MM-DD), an ISO time, or a duration such as 24h${name === 'since' ? ', or "all"' : ''}`;
  if (typeof value !== 'string') throw new Error(what);
  const duration = DURATION.exec(value);
  if (duration) {
    const t = now - Number(duration[1]) * UNIT_MS[duration[2]];
    if (!Number.isFinite(t) || Math.abs(t) > MAX_TIME_MS) throw new Error(`${name} must be a duration that reaches no further back than a date can`);
    return t;
  }
  if (DATE.test(value)) {
    if (!isDay(value)) throw new Error(`${name} must be a day that exists, YYYY-MM-DD`);
    return Date.parse(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`);
  }
  const t = Date.parse(value);
  if (/^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(t)) return t;
  throw new Error(what);
}

// since -> ms since the epoch, or null for "everything" (absent, or "all").
const sinceMs = (since, now) => (since === undefined || since === 'all' ? null : timeMs('since', since, now, false));
// until -> ms since the epoch; absent: now.
const untilMs = (until, now) => (until === undefined ? now : timeMs('until', until, now, true));

// The nearest-rank percentile of sorted numbers.
const rank = (sorted, q) => sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];
function timing(values) {
  const v = values.filter((x) => Number.isInteger(x) && x >= 0).sort((a, b) => a - b);
  if (v.length === 0) return {count: 0, totalMs: 0, p50: null, p95: null, max: null};
  return {count: v.length, totalMs: v.reduce((a, b) => a + b, 0), p50: rank(v, 0.5), p95: rank(v, 0.95), max: v[v.length - 1]};
}

// A map of counts kept to the MAX_CODES largest; the rest under OTHER.
function bounded(counts) {
  const entries = Object.entries(counts).sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]));
  const out = {};
  let other = 0;
  entries.forEach(([k, n], i) => { if (k !== 'OTHER' && i < MAX_CODES) out[k] = n; else other += n; });
  if (other > 0) out.OTHER = other;
  return out;
}

// An error's name in the report. A result: its recorded code if it is the
// runtime's catalogue code or one recordOut names (NO_CODE, MODULE_ERROR,
// OTHER); a module's own code read from an older file, MODULE_ERROR; a record
// from before codes were kept, UNRECORDED. A server call: isError (the
// server's tool answered an error) TOOL_ERROR, a catalogue code, a system
// error's (ECONNREFUSED), else OTHER. Never a code a module chose: it could
// carry data.
const isCatalogue = (c) => typeof c === 'string' && Object.prototype.hasOwnProperty.call(CODES, c);
const NAMED = ['NO_CODE', 'MODULE_ERROR', 'OTHER'];
const SYSTEM_CODE = /^E[A-Z0-9]{1,15}$/;
function resultCode(r) {
  if (r.code === undefined) return 'UNRECORDED';
  if (isCatalogue(r.code) || NAMED.includes(r.code)) return r.code;
  return typeof r.code === 'string' && ERROR_CODE.test(r.code) ? 'MODULE_ERROR' : 'OTHER';
}
function serverCode(r) {
  if (r.outcome === 'isError') return 'TOOL_ERROR';
  return isCatalogue(r.outcome) || (typeof r.outcome === 'string' && SYSTEM_CODE.test(r.outcome)) ? r.outcome : 'OTHER';
}

const keptOut = (estimate) => ({estimate, method: KEPT_OUT_METHOD, bound: 'upper'});

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
// now}) -> a Promise of the report, rejected with a plain message on a bad
// argument. maxGroups: the rows of groups kept (MAX_GROUPS for the tool, whose
// output schema bounds them; the shell's report passes Infinity). The files
// are streamed, and filtered by caller and window as each line is read
// (lib/usage/read.js streamUsage): a plain key never parses another's records.
// Reports run one at a time, as they did when the report was synchronous:
// overlapping reports would each hold their records at once.
let running = Promise.resolve();
function usageReport(...args) {
  const report = running.then(() => buildReport(...args));
  running = report.catch(() => {});
  return report;
}

async function buildReport(args, {caller, isAdmin}, {usage, usageDir = null, now = Date.now, maxGroups = MAX_GROUPS}) {
  const a = args == null ? {} : args;
  for (const k of Object.keys(a)) if (!ARGUMENTS.includes(k)) throw new Error(`unknown argument ${k}: only since, until and groupBy`);
  const groupBy = a.groupBy === undefined ? 'tool' : a.groupBy;
  if (!GROUP_BY.includes(groupBy)) throw new Error(`groupBy must be one of ${GROUP_BY.join(', ')}`);
  const nowMs = now();
  const to = untilMs(a.until, nowMs);
  // A plain key's default: the 31 days before until.
  const from = (isAdmin !== true && a.since === undefined) ? to - PLAIN_DEFAULT_DAYS * 86400000 : sinceMs(a.since, nowMs);
  if (from != null && to < from) throw new Error('until is before since: the window would be empty');
  const until = new Date(to).toISOString();
  const fromIso = from == null ? null : new Date(from).toISOString();

  // No recorder (the command line): the files alone. A recorder that writes
  // to this usage directory has its records there, so the files are read,
  // its own included, and its bounded memory is not (review of #59).
  const ownFiles = usage != null && usage.writesTo != null && usageDir != null && path.resolve(usage.writesTo) === path.resolve(usageDir);
  const fromMemory = usage != null && !ownFiles;
  const source = fromMemory ? ['memory'] : [];
  // A plain caller sees its own calls; one with no caller id sees none.
  const nobody = isAdmin !== true && caller == null;
  const own = (r) => isAdmin === true || r.caller === caller;
  const memory = fromMemory && !nobody ? usage.records().map((r) => ({...normalise(r), process: usage.process})).filter((r) => r.t != null && own(r)) : [];
  let files = [];
  if (usageDir != null) {
    // Only the day directories of the window are read (review of #59), and
    // a day past until: a call's result just past it is still its result.
    // (no further than year 9999, past which ISO times stop comparing as text)
    const dayAfterMs = Date.parse(`${until.slice(0, 10)}T00:00:00Z`) + 86400000;
    const dayAfterEnd = new Date(Math.min(dayAfterMs + 86400000 - 1, LAST_TIME_MS)).toISOString();
    files = nobody ? [] : await streamUsage(usageDir, {since: fromIso == null ? undefined : fromIso.slice(0, 10), until: dayAfterEnd.slice(0, 10),
      skip: fromMemory ? usage.process : undefined, from: fromIso == null ? undefined : fromIso, to: dayAfterEnd, caller: isAdmin === true ? null : caller});
    // files read, whether or not any record in them was the caller's
    if ((files.filesRead || 0) > 0 || ownFiles) source.push('files');
  }
  const pool = memory.concat(files);
  let records = pool.filter((r) => (fromIso == null || r.t >= fromIso) && r.t <= until);
  // An acceptance stand-in's server calls: out of every group and total, in
  // a section of their own (lib/usage/aggregate.js standInOf).
  const standIn = require('./aggregate').standInOf(records);
  records = records.filter((r) => !(r.server !== null && r.mapped === true));

  // A server call belongs to the tool call with the same `call` in the same process.
  const key = (r) => `${r.process}\u0000${r.call}`;
  const results = new Map(records.filter((r) => r.server === null).map((r) => [key(r), r]));
  const groupOf = (r) => {
    const owner = r.server === null ? r : results.get(key(r));
    if (groupBy === 'tool') return {tool: cut(owner != null ? owner.tool : NO_RESULT)};
    if (groupBy === 'pack') return {pack: cut((owner != null ? owner.pack : r.pack) || UNKNOWN_PACK)};
    // An acceptance stand-in's calls have a row of their own (lib/usage/labels.js).
    if (groupBy === 'server') return {server: cut(r.server === null ? NO_SERVER : r.server)};
    return {module: cut(typeof r.module === 'string' ? r.module : (r.server === null ? (r.pack || UNKNOWN_MODULE) : UNKNOWN_MODULE))};
  };
  const groups = new Map();
  for (const r of records) {
    const g = {...(isAdmin === true ? {caller: cut(typeof r.caller === 'string' ? r.caller : '(unknown)')} : {}), ...groupOf(r)};
    const k = JSON.stringify(g);
    if (!groups.has(k)) groups.set(k, {...g, ...zero()});
    add(groups.get(k), r);
  }
  const activity = (g) => g.calls + g.serverCalls;
  const sorted = [...groups.values()].sort((x, y) => (activity(y) - activity(x)) || JSON.stringify(x).localeCompare(JSON.stringify(y)));

  // Each tool call (a result and its server calls, or server calls with no
  // result): what it kept out of the model's context, counted on its day
  // (its result's, or its first server call's).
  const calls = new Map();
  for (const r of records) {
    const k = key(r);
    if (!calls.has(k)) calls.set(k, {bytesIn: 0, bytesOut: 0, serverCalls: 0, result: null, first: r.t});
    const c = calls.get(k);
    if (r.server === null) { c.result = r; c.bytesOut = r.bytesOut; } else { c.bytesIn += r.bytesIn; c.serverCalls += 1; }
    if (r.t < c.first) c.first = r.t;
  }
  // A call with server calls in the window and its result just past until
  // (or before since) still has that result subtracted; one still running has
  // none yet, and counts every byte read: the upper bound.
  const anyResult = new Map(pool.filter((r) => r.server === null).map((r) => [key(r), r]));
  for (const [k, c] of calls) {
    if (c.result == null && anyResult.has(k)) c.bytesOut = anyResult.get(k).bytesOut;
  }
  const keptOf = (c) => Math.round(Math.max(0, c.bytesIn - c.bytesOut) / 4);
  const days = new Map();
  const dayOf = (d) => {
    if (!days.has(d)) days.set(d, {day: d, calls: 0, serverCalls: 0, bytesIn: 0, bytesOut: 0, kept: 0});
    return days.get(d);
  };
  for (const r of records) {
    const d = dayOf(r.t.slice(0, 10));
    if (r.server === null) d.calls += 1; else d.serverCalls += 1;
    d.bytesIn += r.bytesIn;
    d.bytesOut += r.bytesOut;
  }
  let keptTotal = 0;
  for (const c of calls.values()) {
    const kept = keptOf(c);
    keptTotal += kept;
    dayOf((c.result != null ? c.result.t : c.first).slice(0, 10)).kept += kept;
  }
  const dayRows = [...days.values()].sort((x, y) => x.day.localeCompare(y.day))
    .map((d) => ({day: d.day, calls: d.calls, serverCalls: d.serverCalls, bytesIn: d.bytesIn, bytesOut: d.bytesOut, tokensInEst: est(d.bytesIn), tokensOutEst: est(d.bytesOut), keptOut: keptOut(d.kept)}));

  // Profiling: call time, errors by code, server calls per tool call.
  const resultRecords = records.filter((r) => r.server === null);
  const serverRecords = records.filter((r) => r.server !== null);
  const count = (rs, nameOf) => bounded(rs.reduce((m, r) => { const k = nameOf(r); m[k] = (m[k] || 0) + 1; return m; }, {}));
  const perCall = [...calls.values()].filter((c) => c.result != null).map((c) => c.serverCalls);
  const bucket = (n) => (n === 0 ? '0' : n === 1 ? '1' : n <= 4 ? '2-4' : '5+');
  const profile = {
    callMs: timing(resultRecords.map((r) => r.ms)),
    serverCallMs: timing(serverRecords.map((r) => r.ms)),
    errors: {
      calls: count(resultRecords.filter((r) => r.outcome !== 'ok'), resultCode),
      serverCalls: count(serverRecords.filter((r) => r.outcome !== 'ok'), serverCode)
    },
    serverCallsPerCall: {
      mean: perCall.length === 0 ? null : Math.round((perCall.reduce((x, y) => x + y, 0) / perCall.length) * 100) / 100,
      max: perCall.length === 0 ? null : perCall.reduce((x, y) => (y > x ? y : x), 0),
      distribution: perCall.reduce((m, n) => { m[bucket(n)] += 1; return m; }, {'0': 0, '1': 0, '2-4': 0, '5+': 0})
    }
  };

  let first = null;
  let last = null;
  for (const r of records) {
    if (first == null || r.t < first) first = r.t;
    if (last == null || r.t > last) last = r.t;
  }
  return {
    window: {since: fromIso, until, first, last},
    groupBy,
    method: METHOD,
    source,
    groups: sorted.slice(0, maxGroups).map(withEstimates),
    groupsOmitted: Math.max(0, sorted.length - maxGroups),
    totals: {...withEstimates(records.reduce(add, zero())), keptOut: keptOut(keptTotal)},
    days: dayRows.slice(-MAX_DAYS),
    daysOmitted: Math.max(0, dayRows.length - MAX_DAYS),
    profile,
    ...(standIn != null ? {standIn: boundedStandIn(standIn)} : {})
  };
}

// An acceptance stand-in's section: its servers' names cut to MAX_NAME, the
// map kept to the MAX_SERVERS busiest (then by name), the rest added to
// "(other servers)".
function boundedStandIn(standIn) {
  const merged = {};
  for (const [s, n] of Object.entries(standIn.servers)) merged[cut(s)] = (merged[cut(s)] || 0) + n;
  const servers = Object.entries(merged).sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]));
  if (servers.length <= MAX_SERVERS) return {...standIn, servers: merged};
  const kept = Object.fromEntries(servers.slice(0, MAX_SERVERS - 1));
  const OTHER_SERVERS = '(other servers)';
  kept[OTHER_SERVERS] = (kept[OTHER_SERVERS] || 0) + servers.slice(MAX_SERVERS - 1).reduce((s, [, n]) => s + n, 0);
  return {...standIn, servers: kept};
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

const KEPT_OUT = {title: 'tokens kept out of the model\'s context: an upper-bound estimate, not a measurement', type: 'object', properties: {
  estimate: {type: 'integer', minimum: 0},
  method: {type: 'string', const: KEPT_OUT_METHOD},
  bound: {title: 'upper: it takes the model to have read, without the tool, every byte the tool read', type: 'string', const: 'upper'}
}, required: ['estimate', 'method', 'bound'], additionalProperties: false};

const TIMING = {type: 'object', properties: {
  count: {type: 'integer', minimum: 0}, totalMs: {type: 'integer', minimum: 0},
  p50: {type: ['integer', 'null']}, p95: {type: ['integer', 'null']}, max: {type: ['integer', 'null']}
}, required: ['count', 'totalMs', 'p50', 'p95', 'max'], additionalProperties: false};

const CODE_COUNTS = {title: 'errors by code: the runtime\'s codes, TOOL_ERROR, a system error\'s, MODULE_ERROR (a module\'s own code), NO_CODE, UNRECORDED (an older record), OTHER (anything else, and past the 32 most frequent)',
  type: 'object', propertyNames: {pattern: '^[A-Z][A-Z0-9_]{0,63}$', maxLength: 64},
  additionalProperties: {type: 'integer', minimum: 1}, maxProperties: MAX_CODES + 1};

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    since: {type: 'string', description: 'a day (YYYY-MM-DD), an ISO time, a duration back from now (30m, 24h, 7d), or "all" (from the first record); absent: the last 31 days for a plain key, everything recorded for an admin'},
    until: {type: 'string', description: 'a day (YYYY-MM-DD, through its end), an ISO time, or a duration back from now; absent: now'},
    groupBy: {type: 'string', enum: GROUP_BY, description: 'what each row counts: a tool (the default), a server, a pack, or a module'}
  },
  additionalProperties: false
};

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    window: {type: 'object', properties: {
      since: {type: ['string', 'null'], maxLength: 32}, until: {type: 'string', maxLength: 32},
      first: {title: 'the first record in the window', type: ['string', 'null'], maxLength: 32},
      last: {title: 'the last record in the window', type: ['string', 'null'], maxLength: 32}
    }, required: ['since', 'until', 'first', 'last'], additionalProperties: false},
    groupBy: {type: 'string', enum: GROUP_BY},
    method: {type: 'string', const: METHOD},
    source: {type: 'array', items: {type: 'string', enum: ['memory', 'files', 'metering']}, maxItems: 3},
    groups: {type: 'array', maxItems: MAX_GROUPS, items: {type: 'object', properties: {
      caller: {title: 'the opaque caller id; admin reports only', type: 'string', maxLength: MAX_NAME},
      tool: {type: 'string', maxLength: MAX_NAME}, server: {type: 'string', maxLength: MAX_NAME},
      pack: {type: 'string', maxLength: MAX_NAME}, module: {type: 'string', maxLength: MAX_NAME},
      ...COUNTS}, required: COUNT_NAMES, additionalProperties: false}},
    groupsOmitted: {title: 'groups past the 500 most active, in no row (still in totals)', type: 'integer', minimum: 0},
    totals: {title: 'the period\'s totals: the headline', type: 'object', properties: {...COUNTS, keptOut: KEPT_OUT}, required: [...COUNT_NAMES, 'keptOut'], additionalProperties: false},
    days: {title: 'one row per UTC day with activity, oldest first; at most the newest 366', type: 'array', maxItems: MAX_DAYS, items: {type: 'object', properties: {
      day: {type: 'string', pattern: '^\\d{4}-\\d\\d-\\d\\d$', maxLength: 10},
      calls: COUNTS.calls, serverCalls: COUNTS.serverCalls, bytesIn: COUNTS.bytesIn, bytesOut: COUNTS.bytesOut,
      tokensInEst: COUNTS.tokensInEst, tokensOutEst: COUNTS.tokensOutEst, keptOut: KEPT_OUT
    }, required: ['day', 'calls', 'serverCalls', 'bytesIn', 'bytesOut', 'tokensInEst', 'tokensOutEst', 'keptOut'], additionalProperties: false}},
    daysOmitted: {title: 'days with activity before the rows kept (still in totals)', type: 'integer', minimum: 0},
    profile: {type: 'object', properties: {
      callMs: TIMING,
      serverCallMs: TIMING,
      errors: {type: 'object', properties: {calls: CODE_COUNTS, serverCalls: CODE_COUNTS}, required: ['calls', 'serverCalls'], additionalProperties: false},
      serverCallsPerCall: {type: 'object', properties: {
        mean: {type: ['number', 'null'], minimum: 0}, max: {type: ['integer', 'null'], minimum: 0},
        distribution: {type: 'object', properties: {'0': {type: 'integer'}, '1': {type: 'integer'}, '2-4': {type: 'integer'}, '5+': {type: 'integer'}},
          required: ['0', '1', '2-4', '5+'], additionalProperties: false}
      }, required: ['mean', 'max', 'distribution'], additionalProperties: false}
    }, required: ['callMs', 'serverCallMs', 'errors', 'serverCallsPerCall'], additionalProperties: false},
    standIn: {title: 'server calls an acceptance stand-in answered (--remoteOriginMap): in no group or total', type: 'object', properties: {
      serverCalls: {type: 'integer'}, bytesIn: {type: 'integer'}, linesIn: {type: 'integer'}, tokensInEst: {type: 'integer'},
      servers: {type: 'object', propertyNames: {maxLength: MAX_NAME}, additionalProperties: {type: 'integer'}, maxProperties: MAX_SERVERS}}, required: ['serverCalls', 'bytesIn', 'linesIn', 'tokensInEst', 'servers'], additionalProperties: false}
  },
  required: ['window', 'groupBy', 'method', 'source', 'groups', 'groupsOmitted', 'totals', 'days', 'daysOmitted', 'profile'],
  additionalProperties: false
};

// The report as text for a person and CSV for a spreadsheet. Exact lines and
// bytes; the token columns are labelled as the estimate they are.
const KEYS = ['caller', 'tool', 'server', 'pack', 'module'];
const CSV_HEADER = 'caller,tool,server,pack,module,calls,server_calls,bytes_in,lines_in,bytes_out,lines_out,tokens_in_est,tokens_out_est';
const n = (x) => x.toLocaleString('en-US');
const cell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

// The first line: the days the records cover, and the window asked for. The
// second, the headline: the period's totals and the tokens kept out of the
// model's context, named as the upper-bound estimate it is.
function reportText(r) {
  const asked = `${r.window.since == null ? 'all records' : `from ${r.window.since}`} to ${r.window.until}`;
  const covered = r.window.first == null ? 'usage: none recorded' : `usage from ${r.window.first.slice(0, 10)} to ${r.window.last.slice(0, 10)}`;
  const head = `${covered} (window: ${asked}), by ${r.groupBy} (sources: ${r.source.join(', ') || 'none'})`;
  const t0 = r.totals;
  const headline = `period: ${n(t0.calls)} calls, ${n(t0.serverCalls)} server calls; about ${n(t0.keptOut.estimate)} fewer tokens: kept out of the model's context, an upper-bound estimate (${t0.keptOut.method})`;
  // Never counted above: what an acceptance stand-in answered.
  const standIn = r.standIn == null ? [] : [`acceptance stand-in (in no row or total above): ${n(r.standIn.serverCalls)} server calls (${Object.entries(r.standIn.servers).map(([s, c]) => `${n(c)} to ${s}`).join(', ')}); read ${n(r.standIn.linesIn)} lines (${n(r.standIn.bytesIn)} B)`];
  if (r.groups.length === 0) return `${[head, 'no usage recorded', ...standIn].join('\n')}\n`;
  const lines = [head, headline];
  for (const g of r.groups) {
    const label = KEYS.filter((k) => g[k] !== undefined).map((k) => g[k]).join(' ');
    lines.push(`  ${label}: ${n(g.calls)} calls, ${n(g.serverCalls)} server calls; read ${n(g.linesIn)} lines (${n(g.bytesIn)} B), returned ${n(g.linesOut)} lines (${n(g.bytesOut)} B); about ${n(g.tokensInEst)} and ${n(g.tokensOutEst)} tokens, estimate (${r.method})`);
  }
  const t = r.totals;
  lines.push(`total: ${n(t.calls)} calls, ${n(t.serverCalls)} server calls; read ${n(t.linesIn)} lines, returned ${n(t.linesOut)} lines; about ${n(t.tokensInEst)} and ${n(t.tokensOutEst)} tokens, estimate (${r.method})`);
  if (r.groupsOmitted > 0) lines.push(`  (${n(r.groupsOmitted)} less active groups not listed; in the totals)`);
  lines.push('by day:');
  if (r.daysOmitted > 0) lines.push(`  (${n(r.daysOmitted)} earlier days not listed; in the totals)`);
  for (const d of r.days) lines.push(`  ${d.day}: ${n(d.calls)} calls, ${n(d.serverCalls)} server calls; about ${n(d.keptOut.estimate)} fewer tokens (upper-bound estimate)`);
  const p = r.profile;
  const ms = (x) => (x.count === 0 ? 'none' : `${n(x.count)}, p50 ${n(x.p50)} ms, p95 ${n(x.p95)} ms, max ${n(x.max)} ms`);
  const codes = (m) => (Object.keys(m).length === 0 ? 'none' : Object.entries(m).map(([c, k]) => `${c} ${n(k)}`).join(', '));
  lines.push(`profile: calls ${ms(p.callMs)}; server calls ${ms(p.serverCallMs)}`);
  lines.push(`  errors: calls ${codes(p.errors.calls)}; server calls ${codes(p.errors.serverCalls)}`);
  const s = p.serverCallsPerCall;
  lines.push(`  server calls per call: ${s.mean == null ? 'none' : `mean ${s.mean}, max ${n(s.max)}`} (0: ${n(s.distribution['0'])}, 1: ${n(s.distribution['1'])}, 2-4: ${n(s.distribution['2-4'])}, 5+: ${n(s.distribution['5+'])})`);
  lines.push(...standIn);
  return `${lines.join('\n')}\n`;
}

function reportCsv(r) {
  const rows = r.groups.map((g) => [...KEYS.map((k) => (g[k] === undefined ? '' : g[k])), g.calls, g.serverCalls, g.bytesIn, g.linesIn, g.bytesOut, g.linesOut, g.tokensInEst, g.tokensOutEst].map(cell).join(','));
  return `${[CSV_HEADER, ...rows].join('\n')}\n`;
}

module.exports = {usageReport, reportText, reportCsv, INPUT_SCHEMA, OUTPUT_SCHEMA, METHOD, KEPT_OUT_METHOD, CSV_HEADER};
