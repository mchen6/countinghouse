// error-cluster: group WARN and ERROR log lines that say the same thing. A
// pure function of its input, like pii-redact.
//
// "The same thing" is deliberately crude: two messages cluster together when
// they are identical once every UUID, every hex string of eight or more
// characters and every run of digits is replaced by '#'. That is enough to
// fold "timeout after 3000ms request=<uuid>" a thousand times into one line of
// a report, which is the job; it is not log-template mining.

const DEFAULT_TOP_CLUSTERS = 10;
const MAX_TOP_CLUSTERS     = 50;
const MAX_TEXT             = 160;

const LINE_RE = /^(\d{4}-\d{2}-\d{2}T[0-9:.]+(?:Z|[+-]\d{2}:\d{2}))\s+(DEBUG|INFO|WARN|ERROR)\s+(.*)$/;

// UUIDs first: left to the other two, one UUID would become five '#'.
const UUID_RE   = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const HEX_RE    = /\b[0-9a-f]{8,}\b/gi;
const DIGITS_RE = /\d+/g;

module.exports = async (input) => {
  const opts  = input || {};
  const lines = opts.lines;

  if (!Array.isArray(lines) || !lines.every((l) => typeof l === 'string')) {
    throw new DeviceError('ARGUMENTS_INVALID', 'lines must be an array of strings');
  }

  const top = (opts.topClusters != null) ? opts.topClusters : DEFAULT_TOP_CLUSTERS;
  if (!Number.isInteger(top) || top < 1 || top > MAX_TOP_CLUSTERS) {
    throw new DeviceError('ARGUMENTS_INVALID', `topClusters must be an integer from 1 to ${MAX_TOP_CLUSTERS}`);
  }

  const byLevel  = {DEBUG: 0, INFO: 0, WARN: 0, ERROR: 0};
  const clusters = new Map();
  let unparsed = 0;

  for (const line of lines) {
    const m = LINE_RE.exec(line);
    if (m == null) { unparsed++; continue; }

    const timestamp = m[1];
    const level     = m[2];
    const message   = m[3];

    byLevel[level]++;
    if (level !== 'WARN' && level !== 'ERROR') continue;

    const template = message.replace(UUID_RE, '#').replace(HEX_RE, '#').replace(DIGITS_RE, '#').slice(0, MAX_TEXT);
    const key      = `${level}|${template}`;
    const existing = clusters.get(key);

    if (existing == null) {
      clusters.set(key, {template: template, level: level, count: 1,
                         firstSeen: timestamp, lastSeen: timestamp,
                         sample: message.slice(0, MAX_TEXT)});
    } else {
      existing.count++;
      // ISO timestamps in one format order the same as strings.
      if (timestamp < existing.firstSeen) existing.firstSeen = timestamp;
      if (timestamp > existing.lastSeen)  existing.lastSeen  = timestamp;
    }
  }

  const sorted = Array.from(clusters.values()).sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    if (a.template !== b.template) return (a.template < b.template) ? -1 : 1;
    return (a.level < b.level) ? -1 : (a.level > b.level) ? 1 : 0;
  });

  return {output: {
    lineCount:    lines.length,
    unparsed:     unparsed,
    byLevel:      byLevel,
    clusterCount: sorted.length,
    clusters:     sorted.slice(0, top)
  }};
};
