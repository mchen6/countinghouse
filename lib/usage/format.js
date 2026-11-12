'use strict';
// (Moved here from ch-report, local-mode spec §5.) The report as text for a person and as CSV for a spreadsheet. Exact lines and
// bytes; token columns labelled as the estimate they are. It reports what was
// read and what was returned, never what was "saved".

const CSV_HEADER = 'pack,tool,calls,server_calls,bytes_in,lines_in,bytes_out,lines_out,tokens_in_est,tokens_out_est';

const n = (x) => x.toLocaleString('en-US');
function size(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const sizes = (x) => `${n(x.linesIn)} lines (${size(x.bytesIn)}) in, ${n(x.linesOut)} lines (${size(x.bytesOut)}) out, ~${n(x.tokensInEst)} and ~${n(x.tokensOutEst)} tokens (estimate, bytes/4)`;

function formatText(agg) {
  const t = agg.totals;
  if (t.calls + t.serverCalls === 0) return 'no usage recorded\n';
  const packCalls = agg.replaced.reduce((sum, r) => sum + r.packCalls, 0);
  const stoodFor = agg.replaced.reduce((sum, r) => sum + r.serverCalls, 0);
  const lines = [
    `${n(packCalls)} pack calls stood for ${n(stoodFor)} server calls; ${n(t.calls)} tool calls in all, from ${agg.processes.length} launcher process(es).`,
    `read ${n(t.linesIn)} lines (${size(t.bytesIn)}) from servers; ${n(t.linesOut)} lines (${size(t.bytesOut)}) returned to the model.`,
    `tokens, estimate (bytes/4): about ${n(t.tokensInEst)} read, ${n(t.tokensOutEst)} returned.`,
    '', 'by pack:'
  ];
  for (const x of agg.byPack) lines.push(`  ${x.pack}: ${n(x.calls)} calls, ${n(x.serverCalls)} server calls; ${sizes(x)}`);
  lines.push('', 'by tool:');
  for (const x of agg.byTool) lines.push(`  ${x.pack} ${x.tool}: ${n(x.calls)} calls stood for ${n(x.serverCalls)} server calls; ${sizes(x)}`);
  if (agg.byServer.length) {
    lines.push('', 'by server:');
    for (const s of agg.byServer) {
      const tools = Object.entries(s.tools).sort().map(([k, v]) => `${k} ${n(v)}`).join(', ');
      lines.push(`  ${s.server}: ${n(s.serverCalls)} calls (${tools}), ${n(s.linesIn)} lines (${size(s.bytesIn)}); credential used: ${s.credentials.join(', ') || 'none'} (by name)`);
    }
  }
  lines.push('', 'by process:');
  for (const p of agg.processes) lines.push(`  pid ${p.pid}, started ${p.started}: ${n(p.calls)} calls, ${n(p.serverCalls)} server calls, ${p.first} to ${p.last}`);
  return `${lines.join('\n')  }\n`;
}

const cell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

function formatCsv(agg) {
  const rows = agg.byTool.map((x) => [x.pack, x.tool, x.calls, x.serverCalls, x.bytesIn, x.linesIn, x.bytesOut, x.linesOut, x.tokensInEst, x.tokensOutEst].map(cell).join(','));
  return `${[CSV_HEADER, ...rows].join('\n')  }\n`;
}

module.exports = {formatText, formatCsv, CSV_HEADER};
