// secret-detect: DEMO-GRADE credential detection.
//
// Read the scope statement in api.json's modelDescription before drawing any
// conclusion from this module's output, and read examples/repo-review/README.md
// for how it differs from gitleaks/trufflehog. Short version: this is twenty
// regular expressions. It has no entropy scoring, does not walk git history,
// does not verify that a matched credential is live, and has no allowlist. It
// exists to be a realistic *pure function* leaf in a composite-tool demo.
//
// The one property it does hold rigorously: a matched credential never leaves
// this module intact. Masking happens here, and the output schema caps
// `redacted` at 120 characters, so the guarantee does not rest on this file
// alone -- see schema.json.
const DISCLAIMER =
  'Demo-grade regex detection: no entropy analysis, no git history, no liveness ' +
  'check, no allowlist. Expect false positives (fixtures, docs) and false ' +
  'negatives (unknown formats). Not a substitute for gitleaks or trufflehog.';

const DEFAULT_MAX_FINDINGS = 500;

// The excerpt cap the output schema enforces. Kept here as a constant so the
// handler clamps to the same number rather than discovering it as a validation
// failure at the boundary.
const MAX_REDACTED_LENGTH = 120;

// Each pattern captures the credential body in group 1 (or declares
// secretGroup: null when the match itself is a marker rather than a secret, as
// with a PEM header). Order matters only for the containment de-dup below:
// more specific patterns come before the generic ones they overlap with.
const PATTERNS = [
  {label: 'private-key-block', severity: 'high', secretGroup: null,
   re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g},

  {label: 'aws-access-key-id', severity: 'high',
   re: /\b(A(?:KIA|SIA|GPA|IDA|ROA|NPA|NVA|3T)[0-9A-Z]{16})\b/g},

  {label: 'aws-secret-access-key', severity: 'high',
   re: /aws_?secret_?access_?key["'\s]*[:=]["'\s]*([A-Za-z0-9/+=]{40})/gi},

  {label: 'azure-storage-account-key', severity: 'high',
   re: /AccountKey=([A-Za-z0-9+/=]{40,})/g},

  {label: 'github-token', severity: 'high',
   re: /\b((?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,})\b/g},

  {label: 'gitlab-token', severity: 'high',
   re: /\b(glpat-[A-Za-z0-9_-]{20,})\b/g},

  {label: 'slack-token', severity: 'high',
   re: /\b(xox[abposr]-[A-Za-z0-9-]{10,})\b/g},

  {label: 'slack-webhook-url', severity: 'high',
   re: /(https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9_]+\/B[A-Za-z0-9_]+\/[A-Za-z0-9_]+)/g},

  {label: 'stripe-key', severity: 'high',
   re: /\b((?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,})\b/g},

  {label: 'google-api-key', severity: 'high',
   re: /\b(AIza[0-9A-Za-z_-]{35})\b/g},

  {label: 'npm-token', severity: 'high',
   re: /\b(npm_[A-Za-z0-9]{36})\b/g},

  {label: 'anthropic-api-key', severity: 'high',
   re: /\b(sk-ant-[A-Za-z0-9_-]{20,})\b/g},

  {label: 'openai-api-key', severity: 'high',
   re: /\b(sk-(?:proj-)?[A-Za-z0-9_-]{20,})\b/g},

  {label: 'twilio-api-key', severity: 'medium',
   re: /\b(SK[0-9a-fA-F]{32})\b/g},

  {label: 'authorization-header-literal', severity: 'high',
   re: /authorization["'\s]*[:=]["'\s]*(?:Bearer|Basic|token)\s+([^"'\s,}]{8,})/gi},

  // Connection strings carry the credential in the middle of a URL, so they get
  // their own redactor below rather than the generic one.
  {label: 'db-connection-string-with-password', severity: 'high', urlPassword: true,
   re: /\b((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|rediss?|amqps?|mssql):\/\/[^\s:@'"/]+:([^\s@'"/]+)@[^\s'"]+)/g},

  {label: 'basic-auth-in-url', severity: 'medium', urlPassword: true,
   re: /\b(https?:\/\/[^\s:@'"/]+:([^\s@'"/]+)@[^\s'"]+)/g},

  {label: 'jwt', severity: 'medium',
   re: /\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g},

  {label: 'dotenv-style-secret', severity: 'medium',
   re: /^[ \t]*(?:export[ \t]+)?[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|APIKEY|API_KEY)[A-Z0-9_]*[ \t]*=[ \t]*(\S{8,})[ \t]*$/gm},

  {label: 'generic-credential-assignment', severity: 'medium',
   re: /(?:secret|password|passwd|pwd|token|api[_-]?key|apikey|access[_-]?key|auth[_-]?token|client[_-]?secret)["']?[ \t]*[:=][ \t]*["']([^"'\s]{8,})["']/gi}
];

// Byte offset -> 1-based line number, via the file's line-start table. Built
// once per file: a per-match scan of the preceding text would be quadratic on a
// 400KB lockfile, which is exactly the kind of file this demo scans.
function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

function lineOf(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}

// Never the whole credential, and never its tail. A three-character head is
// enough to tell an AWS key from a JWT when triaging; the length is enough to
// tell a real key from a placeholder like "changeme".
function mask(secret) {
  const n = secret.length;
  if (n <= 8) return `***(${n} chars)`;
  return `${secret.slice(0, 3)}***(${n} chars)`;
}

// Replace exactly the credential's span inside the matched text, then clamp.
// Splicing by offset rather than string replacement, so a credential that also
// occurs elsewhere in the match cannot survive by being replaced in the wrong
// place.
function redact(matched, secret) {
  let shown = matched;

  if (secret != null && secret !== '') {
    const at = matched.indexOf(secret);
    if (at === -1) {
      // Defensive: if the span cannot be located, show nothing rather than
      // guessing. A finding with no excerpt is still a usable finding; a
      // finding with an unmasked excerpt is a leak.
      shown = `[match not excerpted safely] ${mask(secret)}`;
    } else {
      shown = matched.slice(0, at) + mask(secret) + matched.slice(at + secret.length);
    }
  }

  shown = shown.replace(/\s+/g, ' ').trim();
  if (shown.length > MAX_REDACTED_LENGTH) shown = `${shown.slice(0, MAX_REDACTED_LENGTH - 1)}…`;
  return shown;
}

// Two patterns matching the same span is one finding, not two: `sk-ant-...`
// matches both the Anthropic and the generic OpenAI pattern. Containment rather
// than equality, because the generic assignment pattern's match encloses the
// specific one's.
function overlaps(accepted, start, end) {
  return accepted.some((r) => start < r.end && end > r.start);
}

function scanFile(file, findings, cap) {
  const text   = file.content;
  const starts = lineStarts(text);
  const accepted = [];

  for (const pattern of PATTERNS) {
    pattern.re.lastIndex = 0;
    let m;

    while ((m = pattern.re.exec(text)) !== null) {
      // A zero-length match would spin forever; no pattern here can produce
      // one, but the loop should not depend on that staying true.
      if (m[0].length === 0) { pattern.re.lastIndex++; continue; }

      const start = m.index;
      const end   = start + m[0].length;

      if (!overlaps(accepted, start, end)) {
        accepted.push({start: start, end: end});

        // urlPassword patterns put the password in group 2; everything else
        // uses group 1, and secretGroup: null means the match is a marker.
        const secret = (pattern.secretGroup === null) ? null
                     : (pattern.urlPassword === true ? m[2] : m[1]);

        findings.push({
          file:     file.path,
          line:     lineOf(starts, start),
          type:     pattern.label,
          severity: pattern.severity,
          redacted: redact(m[0], secret)
        });

        if (findings.length >= cap) return true;
      }
    }
  }
  return false;
}

function positiveIntOr(value, fallback) {
  if (value == null) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new DeviceError('ARGUMENTS_INVALID', `expected a positive integer, got ${JSON.stringify(value)}`);
  }
  return value;
}

module.exports = async (input, ctx) => {
  if (input == null || !Array.isArray(input.files)) {
    throw new DeviceError('ARGUMENTS_INVALID', 'files must be an array of {path, content}');
  }

  const cap = positiveIntOr(input.maxFindings, DEFAULT_MAX_FINDINGS);
  const findings = [];
  let bytesScanned = 0;
  let filesScanned = 0;
  let truncated = false;

  for (const file of input.files) {
    if (file == null || typeof file.path !== 'string' || typeof file.content !== 'string') {
      throw new DeviceError('ARGUMENTS_INVALID', 'every entry in files needs a string path and string content');
    }
    filesScanned++;
    bytesScanned += Buffer.byteLength(file.content, 'utf8');

    if (scanFile(file, findings, cap)) { truncated = true; break; }
  }

  const byType = {};
  for (const f of findings) byType[f.type] = (byType[f.type] || 0) + 1;

  ctx.log(`secret-detect: ${findings.length} findings across ${filesScanned} files (${bytesScanned} bytes)`);

  return {
    output: {
      filesScanned: filesScanned,
      bytesScanned: bytesScanned,
      findingCount: findings.length,
      truncated:    truncated,
      byType:       byType,
      findings:     findings,
      disclaimer:   DISCLAIMER
    }
  };
};
