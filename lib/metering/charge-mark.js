'use strict';
// Whether a provider's charges can be recorded now (the owner's decision,
// 11-27: a billed call runs only while its charge can be recorded). A charge
// that fails -- the local ledger's write, Redis's answer -- marks the
// provider: the next billed call is refused retryably. While marked, at most
// one probe every PROBE_MS (the provider's own: a write of the ledger, a
// PING); one that succeeds clears the mark and the call goes on; between
// probes the mark refuses without touching the store (a full disk's ledger is
// not rewritten on every billed call). The mark and its clearing are each
// said once, at error and at info: the provider's own words.
//
// opts: {probe(cb) -> cb(err), refusal() -> the CountinghouseError to answer,
// marked(code) -> the line said when the mark is set, cleared() -> the line
// said when it clears, now() -> ms}.
const PROBE_MS = 1000;

// (an error's code, as a log line may name it: code-shaped only, never a
// store's message)
function codeOf(err) {
  return (err != null && typeof(err.code) === 'string' && /^[A-Z][A-Z0-9_]*$/.test(err.code)) ? err.code : 'ERROR';
}

// (said through the logger; a bare process has none, and a log line is
// never a charge's error)
const LOG = require('../logger');
function say(level, line) {
  try { LOG[level](line); } catch (e) { /* no logger */ }
}

function chargeMark(opts) {
  const now = typeof(opts.now) === 'function' ? opts.now : Date.now;
  let marked = false;
  let lastProbe = 0;
  let probing = null;   // (the probe in flight: every check meanwhile waits for it)
  // (bumped by every failure: a probe clears the mark only if none came
  // while it was out)
  let failures = 0;
  const mark = (err) => {
    failures++;
    if (marked) return;
    marked = true;
    lastProbe = now();
    say('E', opts.marked(codeOf(err)));
  };
  const clear = () => {
    if (!marked) return;
    marked = false;
    say('I', opts.cleared());
  };
  // -> cb(null) when a charge can be recorded, else cb(the refusal)
  const check = (cb) => {
    if (!marked) return cb(null);
    if (probing != null) return probing.push(cb);
    if (now() - lastProbe < PROBE_MS) return cb(opts.refusal());
    lastProbe = now();
    probing = [cb];
    const at = failures;
    return opts.probe((err) => {
      const waiting = probing;
      probing = null;
      const ok = (err == null && failures === at);
      if (ok) clear();
      const answer = ok ? null : opts.refusal();
      for (let i = 0; i < waiting.length; i++) waiting[i](answer);
    });
  };
  return {mark, check, marked: () => marked};
}

module.exports = {chargeMark, codeOf, PROBE_MS};
