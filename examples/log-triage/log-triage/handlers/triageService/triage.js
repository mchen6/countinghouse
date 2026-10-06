// log-triage: one MCP tools/call, 2N + 2 in-process hops for N log files, and
// a response that cannot contain a raw log line.
//
// What this adds over examples/repo-review is the shape of the bill.
// repo-review makes three hops on every call; here the hop count is decided by
// the data -- one list, then a read and a redact per file, then one cluster --
// and the caller bounds it with maxFiles. Every hop is a ctx.call with
// {detail: true}, so each one is AUTHORIZED as this module, BILLED to the real
// outer caller, and returns the platformMetering record the `bill` is built
// from (docs/composite-tools.md).
//
// The per-file chains run concurrently. Within a chain read comes before
// redact; across chains nothing is ordered, which is why the bill is assembled
// by position afterwards rather than appended to as hops finish.

// ctx.call resolves and enforces the runsModules-bound identity itself and
// does not hand it back. This mirrors it only as a label for the bill; it must
// match the auth config's "runsModules" binding for "log-triage".
const AUTHORIZED_AS_LABEL = 'log-triage-internal';

const DEFAULT_MAX_FILES = 8;
const MAX_MAX_FILES     = 32;

const PII_TYPES = ['email', 'ipv4', 'phone', 'card', 'bearerToken'];

module.exports = async (input, ctx) => {
  const opts = input || {};

  const maxFiles = (opts.maxFiles != null) ? opts.maxFiles : DEFAULT_MAX_FILES;
  if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > MAX_MAX_FILES) {
    throw new DeviceError('ARGUMENTS_INVALID', `maxFiles must be an integer from 1 to ${MAX_MAX_FILES}`);
  }

  // One place that runs a hop, so every hop is billed and recorded the same
  // way. Returns the callee's output together with its bill record; the
  // caller of hop() decides where in the bill that record belongs.
  async function hop(label, file, address, hopInput) {
    let result;
    try {
      result = await ctx.call(address, hopInput, {detail: true});
    } catch (e) {
      throw new DeviceError('DEVICE_ACTION_CALL_FAIL', `${label}${file != null ? ` (${file})` : ''}: ${e.message}`);
    }

    const pm = result.platformMetering;
    return {
      output: result.data.output,
      record: {
        tool:         label,
        file:         file,
        charged:      (pm != null && pm.charged != null) ? pm.charged : null,
        balance:      (pm != null && pm.balance != null) ? pm.balance : null,
        billedTo:     (ctx.caller != null) ? ctx.caller.apiKey : null,
        authorizedAs: AUTHORIZED_AS_LABEL
      }
    };
  }

  // Only pass through what the caller set: the leaf input schemas are
  // additionalProperties:false and their defaults are the zero-config path.
  const dirInput = {};
  if (opts.dir != null) dirInput.dir = opts.dir;

  // --- hop 1: which files exist ------------------------------------------
  const listed  = await hop('log-read/list', null, 'log-read/readService.list', dirInput);
  const all     = listed.output.files;
  const chosen  = all.slice(0, maxFiles);
  const skipped = all.slice(maxFiles).map((f) => f.name);

  // --- per file: read, then redact -- the chains run concurrently ---------
  // Raw lines exist in this worker between the two hops of a chain and are
  // dropped when the chain returns: only the redacted lines are kept.
  const chains = await Promise.all(chosen.map(async (f) => {
    const readInput = Object.assign({name: f.name}, dirInput);
    if (opts.maxBytesPerFile != null) readInput.maxBytes = opts.maxBytesPerFile;

    const read     = await hop('log-read/read', f.name, 'log-read/readService.read', readInput);
    const redacted = await hop('pii-redact/redact', f.name, 'pii-redact/redactService.redact',
                               {lines: read.output.lines});

    return {
      file:    {name: read.output.name, bytes: read.output.bytes,
                lineCount: read.output.lineCount, truncated: read.output.truncated},
      lines:   redacted.output.lines,
      counts:  redacted.output.counts,
      records: [read.record, redacted.record]
    };
  }));

  // --- last hop: cluster everything that was read -------------------------
  // Skipped for an empty directory: there is nothing to cluster, and a hop
  // that cannot change the answer should not be charged for.
  const records = [listed.record];
  for (const c of chains) records.push(c.records[0], c.records[1]);

  let clustered = {lineCount: 0, unparsed: 0, byLevel: {DEBUG: 0, INFO: 0, WARN: 0, ERROR: 0},
                   clusterCount: 0, clusters: []};

  if (chains.length > 0) {
    const clusterInput = {lines: [].concat(...chains.map((c) => c.lines))};
    if (opts.topClusters != null) clusterInput.topClusters = opts.topClusters;

    const cluster = await hop('error-cluster/cluster', null, 'error-cluster/clusterService.cluster', clusterInput);
    clustered = cluster.output;
    records.push(cluster.record);
  }

  // --- aggregate -----------------------------------------------------------
  const bill = records.map((r, i) => Object.assign({hop: i + 1}, r));

  const pii = {total: 0};
  for (const type of PII_TYPES) {
    pii[type] = chains.reduce((sum, c) => sum + c.counts[type], 0);
    pii.total += pii[type];
  }

  const problemLines = clustered.byLevel.WARN + clustered.byLevel.ERROR;
  const summary =
    `Read ${chains.length} of ${all.length} log file(s) under ${listed.output.dir}` +
    `${skipped.length > 0 ? ` (${skipped.length} skipped by maxFiles=${maxFiles})` : ''}: ` +
    `${clustered.lineCount} lines, ${clustered.byLevel.ERROR} ERROR and ${clustered.byLevel.WARN} WARN, ` +
    `${clustered.unparsed} unparsed. ` +
    `${problemLines > 0
        ? `The ${problemLines} warning and error lines fall into ${clustered.clusterCount} cluster(s); the ${clustered.clusters.length} largest are listed. `
        : 'No warning or error lines were found. '}` +
    `Masked ${pii.total} personal-data value(s) before clustering; masking is demo-grade regex matching, ` +
    'so a zero count is not evidence the logs hold none. ' +
    `This call made ${bill.length} internal hop(s) against a worst case of ${2 * maxFiles + 2}.`;

  return {
    output: {
      findings: {
        summary: summary.slice(0, 1000),
        files:   {dir: listed.output.dir, read: chains.map((c) => c.file), skipped: skipped.slice(0, 256)},
        pii:     pii,
        levels:  {DEBUG: clustered.byLevel.DEBUG, INFO: clustered.byLevel.INFO,
                  WARN: clustered.byLevel.WARN, ERROR: clustered.byLevel.ERROR,
                  unparsed: clustered.unparsed},
        clusters: clustered.clusters
      },
      bill: bill,
      cost: {
        filesRead:     chains.length,
        hops:          bill.length,
        charged:       bill.reduce((sum, b) => sum + (b.charged != null ? b.charged : 0), 0),
        maxFiles:      maxFiles,
        worstCaseHops: 2 * maxFiles + 2
      }
    }
  };
};
