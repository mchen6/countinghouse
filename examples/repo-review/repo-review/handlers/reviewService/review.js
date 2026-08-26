// repo-review: one MCP tools/call, three in-process hops, and a response that
// structurally cannot contain the source code the review was derived from.
//
// The three hops are ctx.call('module/service.action', input, {detail: true})
// -- composition by name (docs/composite-tools.md). Each address is declared
// in this module's package.json under "countinghouse.calls" and resolved once
// at load time; the identity the hops run AS is bound in auth.json's
// "runsModules" for this module's friendlyName ("repo-review"), not chosen by
// this handler. {detail: true} is required: it is what makes ctx.call resolve
// to {data, platformMetering} instead of just data, and the `bill` array
// below is built entirely from platformMetering. What this module adds over
// the two-hop composite-demo is a third hop (so the identity and billing
// story is exercised at four levels: outer call plus three inner ones) and a
// deliberately huge intermediate payload, so that "the intermediate result
// never enters the caller's context" is a number rather than a claim.
//
// 6.0.0 shape: one handler file, async (input, ctx), every hop a single
// ctx.call so it is AUTHORIZED as this module and BILLED to the real outer
// caller.

// ctx.call resolves and enforces the runsModules-bound identity itself; it
// does not hand that identity back to the handler. This mirrors it only as a
// label for the bill below -- it must match the auth.json "runsModules"
// binding for "repo-review" or this label, not the actual authorization,
// would drift from reality.
const AUTHORIZED_AS_LABEL = 'repo-review-internal';

const HOP_COST = 1;   // app-layer audit trail only; the real charge comes from platform metering

const DEFAULT_MAX_SECRET_FINDINGS = 100;

const MANIFEST_NAME = 'package.json';
const LOCKFILE_NAMES = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock'];

const MEASUREMENT_NOTE =
  'inProcessBytes is the JSON byte length of every hop payload, both directions, ' +
  'summed. The hops actually travel as structured clones over a worker MessagePort, ' +
  'not as JSON, so this is a stable measure of payload size and not of transport ' +
  'cost. returnedBytes is the JSON byte length of this response\'s findings and bill; ' +
  'it excludes this dataFlow block itself (a further ~800 bytes), because a figure ' +
  'that counted itself could not be computed. For end-to-end wire bytes measured ' +
  'from outside the server, run examples/repo-review/token-comparison.js.';

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

module.exports = async (input, ctx) => {
  const opts = input || {};

  const bill    = [];
  const hopFlow = [];
  let inProcessBytes = 0;

  // One place that runs a hop, so every hop is measured, billed and recorded
  // identically -- and so a fourth hop could not accidentally skip any of it.
  //
  // The byte accounting is deliberately charged to this tool rather than
  // estimated: serializing a multi-megabyte hop payload purely to measure it is
  // real work that a composite tool would not otherwise do. It makes this
  // module's wall-clock time pessimistic, which is the right direction for a
  // demo whose whole point is a favourable comparison.
  async function hop(label, address, hopInput) {
    const inBytes = jsonBytes(hopInput);
    const t0 = Date.now();

    let result;
    try {
      result = await ctx.call(address, hopInput, {detail: true});
    } catch (e) {
      throw new DeviceError('DEVICE_ACTION_CALL_FAIL', `${label}: ${e.message}`);
    }
    const wallMs   = Date.now() - t0;
    const outBytes = jsonBytes(result.data);

    inProcessBytes += inBytes + outBytes;
    hopFlow.push({tool: label, inputBytes: inBytes, outputBytes: outBytes});

    const pm = result.platformMetering;
    bill.push({
      hop:          bill.length + 1,
      tool:         label,
      charged:      (pm != null && pm.charged != null) ? pm.charged : null,
      balance:      (pm != null && pm.balance != null) ? pm.balance : null,
      // Recorded from ctx rather than from the metering reply, so the bill
      // shows which identity this module *intended* each hop to land on. The
      // stop-condition check for this demo is that billedTo stays the outer
      // caller on all three hops, not just the first.
      billedTo:     (ctx.caller != null) ? ctx.caller.apiKey : null,
      authorizedAs: AUTHORIZED_AS_LABEL,
      wallMs:       wallMs
    });

    // App-layer bookkeeping only; never touches balance (ctx.recordUsage).
    ctx.recordUsage(label, HOP_COST, () => {});

    return result.data.output;
  }

  // --- hop 1: read the repository ----------------------------------------
  // Only pass through what the caller actually set: repo-scan's input schema is
  // additionalProperties:false and its defaults are the zero-config path.
  const scanInput = {};
  if (opts.path     != null) scanInput.path     = opts.path;
  if (opts.include  != null) scanInput.include  = opts.include;
  if (opts.exclude  != null) scanInput.exclude  = opts.exclude;
  if (opts.maxBytes != null) scanInput.maxBytes = opts.maxBytes;
  if (opts.maxFiles != null) scanInput.maxFiles = opts.maxFiles;

  const scanned = await hop('repo-scan/scan', 'repo-scan/scanService.scan', scanInput);

  // `scanned.files` holds the full text of the repository, in this worker, for
  // the rest of this function. It is passed to the next two hops and then
  // dropped. Nothing below ever copies a `content` field into the response.
  const maxFindings = (opts.maxSecretFindings != null) ? opts.maxSecretFindings : DEFAULT_MAX_SECRET_FINDINGS;

  // --- hop 2: detect credentials -----------------------------------------
  const secrets = await hop('secret-detect/detect', 'secret-detect/detectService.detect',
                            {files: scanned.files, maxFindings: maxFindings});

  // --- hop 3: audit the manifest -----------------------------------------
  // Fed out of the same scan, so exactly one module in the chain touches disk.
  const manifestFile = scanned.files.find((f) => f.path === MANIFEST_NAME);
  const lockFile     = scanned.files.find((f) => LOCKFILE_NAMES.indexOf(f.path) !== -1);

  let deps;
  if (manifestFile == null) {
    // A missing manifest is a fact about the directory, not a failure: reviewing
    // a repository that has no package.json should still return secret findings.
    deps = {
      analyzed: false,
      packageName: null, packageVersion: null,
      counts: {dependencies: 0, devDependencies: 0, peerDependencies: 0, optionalDependencies: 0, total: 0},
      unpinnedCount: 0, unpinnedByKind: {}, suspicious: [],
      lockfile: {present: false, name: null, format: null, lockfileVersion: null,
                 resolvedPackages: null, missingFromLockCount: 0},
      notes: [`No ${MANIFEST_NAME} at the root of the scanned tree (or the include globs excluded it), so no dependency audit was run.`]
    };
  } else {
    const audited = await hop('dep-audit/audit', 'dep-audit/auditService.audit', {
      manifest:     manifestFile.content,
      lockfile:     (lockFile != null) ? lockFile.content : null,
      lockfileName: (lockFile != null) ? lockFile.path : null
    });

    const unpinnedByKind = {};
    for (const u of audited.unpinned) unpinnedByKind[u.kind] = (unpinnedByKind[u.kind] || 0) + 1;

    deps = {
      analyzed:       true,
      packageName:    audited.packageName,
      packageVersion: audited.packageVersion,
      counts:         audited.counts,
      // The full unpinned list is a per-dependency dump that grows with the
      // project; the aggregate answers the question and the schema stays small.
      unpinnedCount:  audited.unpinned.length,
      unpinnedByKind: unpinnedByKind,
      suspicious:     audited.suspicious.slice(0, 100),
      lockfile: {
        present:              audited.lockfile.present,
        name:                 audited.lockfile.name,
        format:               audited.lockfile.format,
        lockfileVersion:      audited.lockfile.lockfileVersion,
        resolvedPackages:     audited.lockfile.resolvedPackages,
        missingFromLockCount: audited.lockfile.missingFromLock.length
      },
      notes: audited.notes.slice(0, 20)
    };
  }

  // --- aggregate ----------------------------------------------------------
  const bySeverity = {};
  for (const f of secrets.findings) bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;

  const reportedFindings = secrets.findings.slice(0, 200).map((f) => ({
    file:     f.file,
    line:     f.line,
    type:     f.type,
    severity: f.severity,
    redacted: f.redacted
  }));

  const summary =
    `Reviewed ${scanned.fileCount} files (${scanned.byteCount} bytes) under ${scanned.root}. ` +
    `Credential scan: ${secrets.findingCount} finding(s)` +
    `${secrets.findingCount > 0 ? ` (${Object.keys(bySeverity).sort().map((s) => `${bySeverity[s]} ${s}`).join(', ')})` : ''}` +
    `, all excerpts masked; detection is demo-grade regex matching, so treat hits as leads and a clean result as inconclusive. ` +
    `${deps.analyzed
        ? `Dependencies: ${deps.counts.total} declared, ${deps.unpinnedCount} not pinned to an exact version, ${deps.suspicious.length} using a specifier that bypasses registry version resolution` +
          `${deps.lockfile.present ? `; lockfile ${deps.lockfile.name} resolves ${deps.lockfile.resolvedPackages} packages` : '; no lockfile found'}. ` +
          'No network access was used, so this says nothing about known vulnerabilities.'
        : 'No dependency audit was run.'}` +
    `${scanned.truncated ? ` Read was truncated: ${scanned.truncationReason}.` : ''}`;

  const findings = {
    summary: summary.slice(0, 2000),
    scanned: {
      root:             scanned.root,
      fileCount:        scanned.fileCount,
      byteCount:        scanned.byteCount,
      truncated:        scanned.truncated,
      truncationReason: (scanned.truncationReason != null) ? scanned.truncationReason : null
    },
    secrets: {
      findingCount: secrets.findingCount,
      reported:     reportedFindings.length,
      truncated:    secrets.truncated,
      byType:       secrets.byType,
      bySeverity:   bySeverity,
      items:        reportedFindings,
      disclaimer:   secrets.disclaimer
    },
    dependencies: deps
  };

  const returnedBytes = jsonBytes({findings: findings, bill: bill});

  ctx.log(`repo-review: ${inProcessBytes} bytes in-process, ${returnedBytes} bytes returned, ` +
          `${bill.length} hops billed to ${(ctx.caller != null) ? ctx.caller.apiKey : 'unknown'}`);

  return {
    output: {
      findings: findings,
      bill:     bill,
      dataFlow: {
        sourceBytesRead: scanned.byteCount,
        inProcessBytes:  inProcessBytes,
        returnedBytes:   returnedBytes,
        reductionFactor: returnedBytes > 0 ? Number((inProcessBytes / returnedBytes).toFixed(1)) : 0,
        hops:            hopFlow,
        measurement:     MEASUREMENT_NOTE
      }
    }
  };
};
