'use strict';
// The tested-client allowlist for elicitation (part 3, section 2 of
// docs/superpowers/specs/2026-11-14-guarding-settings-by-conversation-design.md;
// plan docs/superpowers/plans/2026-11-14-part3-p2-elicitation.md, Task 1).
//
// MCP elicitation is not proof of a person: the specification lets a client
// answer as it likes. So a loosening is confirmed in a client's dialog only
// for a client we have hand-tested to show the dialog to a person, with no
// automatic answer (docs/development/elicitation-hand-test.md), at or above
// the version that test passed, and only when the request itself declares
// form elicitation (the capability is per request in 2026-07-28; it is never
// inferred from earlier ones). Every other client gets the terminal command.
//
// Each entry: name (clientInfo.name, compared exactly), versionFloor (the
// version the hand test passed, 'major.minor.patch'; null until it has: no
// client is asked), and the conditions its own configuration must meet
// (lib/settings-tool.js asks ch-local for them before every dialog).

// Claude Code's clientInfo.name: not documented. Provisional; Task 8 sets it
// from what Claude Code sends at initialize in Matt's hand test, with the
// floor.
const CLAUDE_CODE = 'claude-code';

const ALLOWLIST = [
  {name: CLAUDE_CODE, versionFloor: null, conditions: 'claude-code'}
];

// 'major.minor.patch', plain digits: anything else (a prerelease, build
// metadata, a 'v') is no tested version.
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const partsOf = (v) => {
  const m = typeof(v) === 'string' ? VERSION.exec(v) : null;
  return m == null ? null : [Number(m[1]), Number(m[2]), Number(m[3])];
};
const atLeast = (version, floor) => {
  const a = partsOf(version);
  const b = partsOf(floor);
  if (a == null || b == null) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
};

// Form elicitation declared: {} (form only) or one with a form key.
function declaresForm(capabilities) {
  const e = capabilities != null && typeof(capabilities) === 'object' ? capabilities.elicitation : null;
  if (e == null || typeof(e) !== 'object' || Array.isArray(e)) return false;
  return Object.keys(e).length === 0 || Object.prototype.hasOwnProperty.call(e, 'form');
}

// {clientInfo, capabilities} -> {ok: true, client: {name, version}, conditions}
// | {ok: false, why}
function clientMayElicit(request) {
  const clientInfo = request != null ? request.clientInfo : null;
  const name = clientInfo != null && typeof(clientInfo.name) === 'string' ? clientInfo.name : null;
  const entry = ALLOWLIST.find((e) => e.name === name);
  if (entry == null) return {ok: false, why: 'not on the tested-client list'};
  if (entry.versionFloor === null) return {ok: false, why: 'not tested yet'};
  if (!atLeast(clientInfo.version, entry.versionFloor)) return {ok: false, why: 'version below the tested floor'};
  if (!declaresForm(request.capabilities)) return {ok: false, why: 'no elicitation capability'};
  return {ok: true, client: {name: name, version: clientInfo.version}, conditions: entry.conditions};
}

module.exports = {clientMayElicit, ALLOWLIST, CLAUDE_CODE};
