#!/usr/bin/env node
'use strict';
// countinghouse-usage: the usage report for the operator's shell (local-mode
// spec §5), from the usage files under --usageDir, every caller grouped by the
// opaque caller id. It needs no running runtime and opens no port.
//
//   countinghouse-usage --usageDir <dir> [--since <day|ISO time|30m|24h|7d>]
//                       [--groupBy tool|server|pack|module] [--json|--csv]
const fs = require('fs');
const {usageReport, reportText, reportCsv} = require('../lib/usage/report');

const USAGE = 'usage: countinghouse-usage --usageDir <dir> [--since <day|ISO time|duration>] [--groupBy tool|server|pack|module] [--json|--csv]\n';
const VALUES = ['--usageDir', '--since', '--groupBy'];
const FLAGS = ['--json', '--csv'];

function main(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUES.includes(a) && i + 1 < argv.length && !argv[i + 1].startsWith('--')) opts[a] = argv[++i];
    else if (FLAGS.includes(a)) opts[a] = true;
    else return fail(a.startsWith('--') && VALUES.includes(a) ? `${a} needs a value` : `not understood: ${a}`);
  }
  if (opts['--usageDir'] === undefined) return fail('--usageDir is required');
  if (opts['--json'] && opts['--csv']) return fail('--json or --csv, not both');
  // A misspelled directory must not read as "no usage recorded".
  let isDir = false;
  try { isDir = fs.statSync(opts['--usageDir']).isDirectory(); } catch (_) { isDir = false; }
  if (!isDir) return fail(`no usage directory at ${opts['--usageDir']}`);
  const args = {};
  if (opts['--since'] !== undefined) args.since = opts['--since'];
  if (opts['--groupBy'] !== undefined) args.groupBy = opts['--groupBy'];
  let report;
  try {
    report = usageReport(args, {caller: null, isAdmin: true}, {usage: null, usageDir: opts['--usageDir']});
  } catch (e) {
    return fail(e.message);
  }
  process.stdout.write(opts['--json'] ? `${JSON.stringify(report, null, 2)}\n` : opts['--csv'] ? reportCsv(report) : reportText(report));
  return 0;
}

function fail(message) {
  process.stderr.write(`countinghouse-usage: ${message}\n${USAGE}`);
  return 2;
}

process.exitCode = main(process.argv.slice(2));
