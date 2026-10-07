// pii-redact: mask personal data in log lines. A pure function of its input --
// no disk, no network, no state -- so the log-triage composite can hand it
// another tool's output without either one touching the filesystem.
//
// DEMO-GRADE. Five regular expressions, nothing else. See the module's
// api.json and the example README for what that does and does not catch.

// Order is load-bearing. The token pattern runs first so the e-mail and digit
// patterns never see inside a token; the card pattern runs before the phone
// pattern because a 16-digit run contains shapes the phone pattern would
// otherwise take a bite out of. A match is replaced whole by its tag: unlike a
// partial mask, a tag cannot leak a prefix or a length.
//
// The e-mail pattern has its own masker. Its lookbehind lets a match start
// only at the beginning of a run of local-part characters, which keeps a long
// run with no @ linear. But a match may also start exactly where the previous
// one ended (a@b.com_c@d.org), so after each match a sticky copy of the
// pattern without the lookbehind is tried first.
const EMAIL = '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}';

function maskEmails(line, tag) {
  const search = new RegExp(`(?<![A-Za-z0-9._%+-])${EMAIL}`, 'g');
  const resume = new RegExp(EMAIL, 'y');
  let out = '';
  let n   = 0;
  let pos = 0;

  for (;;) {
    resume.lastIndex = pos;
    let m = resume.exec(line);
    if (m === null) {
      search.lastIndex = pos;
      m = search.exec(line);
      if (m === null) break;
    }
    out += line.slice(pos, m.index) + tag;
    pos = m.index + m[0].length;
    n++;
  }
  return {text: out + line.slice(pos), n: n};
}

const PATTERNS = [
  {type: 'bearerToken', tag: '<token>', re: /\bBearer\s+[A-Za-z0-9._~+/_-]{16,}=*/g},
  {type: 'email',       tag: '<email>', mask: maskEmails},
  {type: 'card',        tag: '<card>',  re: /\b(?:\d[ -]?){12,18}\d\b/g},
  {type: 'ipv4',        tag: '<ipv4>',  re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g},
  {type: 'phone',       tag: '<phone>', re: /(?:\+\d{1,3}[-. ]?)?(?:\(\d{3}\)|\d{3})[-. ]\d{3}[-. ]\d{4}\b/g}
];

module.exports = async (input) => {
  const lines = (input != null) ? input.lines : null;

  if (!Array.isArray(lines) || !lines.every((l) => typeof l === 'string')) {
    throw new DeviceError('ARGUMENTS_INVALID', 'lines must be an array of strings');
  }

  const counts = {email: 0, ipv4: 0, phone: 0, card: 0, bearerToken: 0};

  const masked = lines.map((line) => {
    let out = line;
    for (const p of PATTERNS) {
      if (p.mask) {
        const r = p.mask(out, p.tag);
        out = r.text;
        counts[p.type] += r.n;
      } else {
        out = out.replace(p.re, () => { counts[p.type]++; return p.tag; });
      }
    }
    return out;
  });

  return {output: {lines: masked, counts: counts}};
};
