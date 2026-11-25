'use strict';
// The tested-client allowlist for elicitation (part 3, section 2 of
// docs/superpowers/specs/2026-11-14-guarding-settings-by-conversation-design.md;
// plan docs/superpowers/plans/2026-11-14-part3-p2-elicitation.md, Task 1).
//
// MCP elicitation is not proof of a person: the specification lets a client
// answer as it likes. So a loosening is confirmed in a client's dialog only
// for a client tested to show the dialog to a person, with no automatic
// answer (by hand once before release, docs/development/elicitation-hand-test.md;
// then automatically for each new version), at a version in a range those
// tests passed, and only when the request itself declares
// form elicitation (the capability is per request in 2026-07-28; it is never
// inferred from earlier ones). Every other client gets the terminal command.
//
// The data is one file, lib/elicitation-clients.json, which the automated
// re-test of each new Claude Code version edits by pull request: each client
// its name (clientInfo.name, compared exactly), the conditions its own
// configuration must meet (lib/settings-tool.js asks ch-local for them
// before every dialog), and its tested version ranges, {from, before}:
// from inclusive, before exclusive. A range names exactly the versions
// tested; there is no open range, so a new version gets no form until it is
// re-tested. A malformed range, or file, gets no form either, and is not a list
// that says no client is tested (noClientTested). The list bounds honest,
// untested clients; a client that lies about its name is no more than a
// script starting its own runtime, which loosens only that runtime (the
// plan's Q1).

// Claude Code's clientInfo.name, as it sends it at initialize (not in its
// docs; seen from 2.1.323, the reviewer).
const CLAUDE_CODE = 'claude-code';

// 'major.minor.patch', plain digits, at most 32 characters: anything else
// (a prerelease, build metadata, a 'v', a version no dialog should carry)
// is no tested version.
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const VERSION_MAX = 32;
const partsOf = (v) => {
  const m = typeof(v) === 'string' && v.length <= VERSION_MAX ? VERSION.exec(v) : null;
  return m == null ? null : [Number(m[1]), Number(m[2]), Number(m[3])];
};
// a < b, both plain
const below = (a, b) => {
  const x = partsOf(a);
  const y = partsOf(b);
  if (x == null || y == null) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
};

// the lists every part of whose data was well formed (noClientTested)
const WHOLE = new WeakSet();

// The data, checked: a frozen list of {name, conditions, tested: [{from,
// before}]}; what is malformed is left out (a client with no well-formed
// range is asked nothing).
function listFrom(data) {
  const clients = data != null && typeof(data) === 'object' && Array.isArray(data.clients) ? data.clients : [];
  const out = [];
  let whole = data != null && clients === data.clients;
  for (const c of clients) {
    if (c == null || typeof(c) !== 'object' || !Array.isArray(c.tested)) whole = false;
    if (c == null || typeof(c) !== 'object' || typeof(c.name) !== 'string' || typeof(c.conditions) !== 'string') { whole = false; continue; }
    const tested = (Array.isArray(c.tested) ? c.tested : []).filter((r) => r != null && typeof(r) === 'object' && !Array.isArray(r)
      && Object.keys(r).sort().join(',') === 'before,from' && partsOf(r.from) != null && partsOf(r.before) != null && below(r.from, r.before))
      .map((r) => Object.freeze({from: r.from, before: r.before}));
    if (Array.isArray(c.tested) && tested.length !== c.tested.length) whole = false;
    out.push(Object.freeze({name: c.name, conditions: c.conditions, tested: Object.freeze(tested)}));
  }
  if (whole) WHOLE.add(out);
  return Object.freeze(out);
}

function readList() {
  try {
    return listFrom(JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'elicitation-clients.json'), 'utf8')));
  } catch (err) {
    return listFrom(null);
  }
}

// frozen: nothing at run time can widen it (a test passes its own list)
const ALLOWLIST = readList();

// Whether the list says that no client is tested, so that no session is ever
// shown a form: read whole, with no tested range. One that could not be read,
// or holds what is malformed, doesn't say so (a range may be what was lost).
// The one condition of what the settings tool says and allows where a form
// can't be (lib/settings-tool.js).
const noClientTested = (list = ALLOWLIST) => WHOLE.has(list) && list.every((e) => e.tested.length === 0);

// Form elicitation declared: {} (form only) or one with a form key.
function declaresForm(capabilities) {
  const e = capabilities != null && typeof(capabilities) === 'object' ? capabilities.elicitation : null;
  if (e == null || typeof(e) !== 'object' || Array.isArray(e)) return false;
  return Object.keys(e).length === 0 || Object.prototype.hasOwnProperty.call(e, 'form');
}

// {clientInfo, capabilities} -> {ok: true, client: {name, version}, conditions}
// | {ok: false, why}. list: ALLOWLIST (a test's own otherwise).
function clientMayElicit(request, list = ALLOWLIST) {
  const clientInfo = request != null ? request.clientInfo : null;
  const name = clientInfo != null && typeof(clientInfo.name) === 'string' ? clientInfo.name : null;
  const entry = list.find((e) => e.name === name);
  if (entry == null) return {ok: false, why: 'not on the tested-client list'};
  if (entry.tested.length === 0) return {ok: false, why: 'not tested yet'};
  const v = clientInfo.version;
  if (partsOf(v) == null || !entry.tested.some((r) => !below(v, r.from) && below(v, r.before))) return {ok: false, why: 'version not in a tested range'};
  if (!declaresForm(request.capabilities)) return {ok: false, why: 'no elicitation capability'};
  return {ok: true, client: {name: name, version: clientInfo.version}, conditions: entry.conditions};
}

// a version in the one plain form (also a pack's, lib/settings-tool.js)
const isPlainVersion = (v) => partsOf(v) != null;

module.exports = {clientMayElicit, noClientTested, declaresForm, isPlainVersion, listFrom, ALLOWLIST, CLAUDE_CODE};
