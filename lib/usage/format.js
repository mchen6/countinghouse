'use strict';
// (Moved here from ch-report, local-mode spec §5.) The report as text for a person and as CSV for a spreadsheet. Exact
// bytes; token columns labelled as the estimate they are. It reports what was
// read and what was returned, never what was "saved".

const CSV_HEADER = 'scenario,tool,calls,server_calls,bytes_in,bytes_out,tokens_in_est,tokens_out_est';

const n = (x) => x.toLocaleString('en-US');
const {size} = require('./index');

const sizes = (x) => `${size(x.bytesIn)} in, ${size(x.bytesOut)} out, ~${n(x.tokensInEst)} and ~${n(x.tokensOutEst)} tokens (estimate, bytes/4)`;

function formatText(agg) {
  const t = agg.totals;
  if (t.calls + t.serverCalls === 0) return 'no usage recorded\n';
  const scenarioCalls = agg.replaced.reduce((sum, r) => sum + r.scenarioCalls, 0);
  const stoodFor = agg.replaced.reduce((sum, r) => sum + r.serverCalls, 0);
  const lines = [
    `${n(scenarioCalls)} scenario calls stood for ${n(stoodFor)} server calls; ${n(t.calls)} tool calls in all, from ${agg.processes.length} launcher process(es).`,
    `read ${size(t.bytesIn)} from servers; ${size(t.bytesOut)} returned to the model.`,
    `tokens, estimate (bytes/4): about ${n(t.tokensInEst)} read, ${n(t.tokensOutEst)} returned.`,
    '', 'by scenario:'
  ];
  for (const x of agg.byScenario) lines.push(`  ${x.scenario}: ${n(x.calls)} calls, ${n(x.serverCalls)} server calls; ${sizes(x)}`);
  lines.push('', 'by tool:');
  for (const x of agg.byTool) lines.push(`  ${x.scenario} ${x.tool}: ${n(x.calls)} calls stood for ${n(x.serverCalls)} server calls; ${sizes(x)}`);
  if (agg.byServer.length) {
    lines.push('', 'by server:');
    for (const s of agg.byServer) {
      const tools = Object.entries(s.tools).sort().map(([k, v]) => `${k} ${n(v)}`).join(', ');
      lines.push(`  ${s.server}: ${n(s.serverCalls)} calls (${tools}), ${size(s.bytesIn)}; credential used: ${s.credentials.join(', ') || 'none'} (by name)`);
    }
  }
  lines.push('', 'by process:');
  for (const p of agg.processes) lines.push(`  pid ${p.pid}, started ${p.started}: ${n(p.calls)} calls, ${n(p.serverCalls)} server calls, ${p.first} to ${p.last}`);
  return `${lines.join('\n')  }\n`;
}

const cell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

function formatCsv(agg) {
  const rows = agg.byTool.map((x) => [x.scenario, x.tool, x.calls, x.serverCalls, x.bytesIn, x.bytesOut, x.tokensInEst, x.tokensOutEst].map(cell).join(','));
  return `${[CSV_HEADER, ...rows].join('\n')  }\n`;
}

module.exports = {formatText, formatCsv, CSV_HEADER};
