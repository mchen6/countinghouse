'use strict';
// The usage report's aggregation (moved here from ch-report, local-mode spec
// §5). The layer-1 report: exact sums of what the runtime counted. An In record
// (server set) is one server call; an Out record (server null) is one tool
// call's result. A server call belongs to the tool call with the same `call`
// in the same process, so it is counted under that call's pack and tool (its
// own `tool` is the server's tool, counted per server); a server call whose
// tool call never recorded a result (the process stopped) is counted under
// "(no result recorded)". Tokens are not counted by anyone here: the token
// columns are an estimate, UTF-8 bytes / 4, and say so wherever they appear.

const ESTIMATE_METHOD = 'utf8 bytes / 4';
const UNKNOWN_PACK = '(unknown)';
const NO_RESULT = '(no result recorded)';
const est = (bytes) => Math.round(bytes / 4);

const zero = () => ({calls: 0, serverCalls: 0, bytesIn: 0, linesIn: 0, bytesOut: 0, linesOut: 0});
function add(sum, r) {
  if (r.server === null) sum.calls++; else sum.serverCalls++;
  sum.bytesIn += r.bytesIn;
  sum.linesIn += r.linesIn;
  sum.bytesOut += r.bytesOut;
  sum.linesOut += r.linesOut;
  return sum;
}
const withEstimates = (s) => ({...s, tokensInEst: est(s.bytesIn), tokensOutEst: est(s.bytesOut)});

function groupBy(records, keyOf, init) {
  const groups = new Map();
  for (const r of records) {
    const key = keyOf(r);
    if (!groups.has(key)) groups.set(key, {...init(r), ...zero()});
    add(groups.get(key), r);
  }
  return [...groups.values()];
}

const byCalls = (a, b) => (b.calls - a.calls) || (b.serverCalls - a.serverCalls);
const callKey = (r) => `${r.process}\u0000${r.call}`;

// records (readUsage's) -> the report object.
// An acceptance stand-in's server calls (mapped: --remoteOriginMap) are not a
// measurement: kept out of every total and grouping, and counted in a section
// of their own. -> {serverCalls, bytesIn, linesIn, tokensInEst, servers: {name: calls}} | null.
function standInOf(records) {
  const mapped = records.filter((r) => r.server !== null && r.mapped === true);
  if (mapped.length === 0) return null;
  const servers = {};
  for (const r of mapped) servers[r.server] = (servers[r.server] || 0) + 1;
  const bytesIn = mapped.reduce((s, r) => s + r.bytesIn, 0);
  return {serverCalls: mapped.length, bytesIn, linesIn: mapped.reduce((s, r) => s + r.linesIn, 0), tokensInEst: est(bytesIn), servers};
}

function aggregate(all) {
  const standIn = standInOf(all);
  const records = all.filter((r) => !(r.server !== null && r.mapped === true));
  const results = new Map();
  for (const r of records) if (r.server === null) results.set(callKey(r), r);
  // Each record with the pack and tool of the tool call it belongs to.
  const owned = records.map((r) => {
    if (r.server === null) return {...r, ofPack: r.pack ?? UNKNOWN_PACK, ofTool: r.tool};
    const result = results.get(callKey(r));
    return result
      ? {...r, ofPack: result.pack ?? UNKNOWN_PACK, ofTool: result.tool}
      : {...r, ofPack: r.pack ?? UNKNOWN_PACK, ofTool: NO_RESULT};
  });

  const processes = new Map();
  const servers = new Map();
  const outcomes = {};
  for (const r of owned) {
    if (!processes.has(r.process)) {
      const [pid, startMs] = r.process.split('-').map(Number);
      processes.set(r.process, {process: r.process, pid, started: Number.isFinite(startMs) ? new Date(startMs).toISOString() : null, first: r.t, last: r.t, ...zero()});
    }
    const p = add(processes.get(r.process), r);
    if (r.t < p.first) p.first = r.t;
    if (r.t > p.last) p.last = r.t;
    if (r.server === null) {
      outcomes[r.outcome] = (outcomes[r.outcome] || 0) + 1;
      continue;
    }
    const label = r.server;
    if (!servers.has(label)) servers.set(label, {server: label, serverCalls: 0, bytesIn: 0, linesIn: 0, credentials: new Set(), tools: {}});
    const s = servers.get(label);
    s.serverCalls++;
    s.bytesIn += r.bytesIn;
    s.linesIn += r.linesIn;
    if (typeof r.credential === 'string') s.credentials.add(r.credential);
    s.tools[r.tool] = (s.tools[r.tool] || 0) + 1;
  }

  const byTool = groupBy(owned, (r) => `${r.ofPack}\u0000${r.ofTool}`, (r) => ({pack: r.ofPack, tool: r.ofTool})).sort(byCalls);
  const byPack = groupBy(owned, (r) => r.ofPack, (r) => ({pack: r.ofPack})).sort(byCalls);
  const byServer = [...servers.values()]
    .map((s) => ({server: s.server, serverCalls: s.serverCalls, bytesIn: s.bytesIn, linesIn: s.linesIn, tokensInEst: est(s.bytesIn), credentials: [...s.credentials].sort(), tools: s.tools}))
    .sort((a, b) => b.serverCalls - a.serverCalls);
  return {
    processes: [...processes.values()].map(withEstimates),
    byTool: byTool.map(withEstimates),
    byServer,
    byPack: byPack.map(withEstimates),
    totals: withEstimates(records.reduce(add, zero())),
    replaced: byTool.filter((t) => t.calls > 0 && t.serverCalls > 0).map((t) => ({pack: t.pack, tool: t.tool, packCalls: t.calls, serverCalls: t.serverCalls})),
    outcomes,
    ...(standIn != null ? {standIn} : {}),
    estimateMethod: ESTIMATE_METHOD
  };
}

module.exports = {aggregate, standInOf, ESTIMATE_METHOD};
