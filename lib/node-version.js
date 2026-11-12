// countinghouse 8 needs Node 22.16, the first 22 with module.registerHooks
// (the sandbox's resolve and load hooks); process.getBuiltinModule,
// --permission and Worker getHeapStatistics are older. framework.js checks
// this before anything else starts.
//
// Below 24.15 the resolve hooks are not consulted by require.resolve or
// createRequire().resolve, so module code's require.resolve would reach
// Node's resolver without the sandbox's require boundary or its path
// mapping. There a compatibility shim routes those calls through the same
// hooks (NEEDS_RESOLVE_SHIM; lib/module-lockdown.js); from 24.15 Node's own
// hook covers it and the shim is not installed. Multi-tenant hosting of
// third-party modules should run 24.15 or later
// (docs/superpowers/specs/2026-11-11-node-floor-shim-design.md).
//
// Node 22 reaches end of life on 2027-04-30: raise the floor to 24.15 then,
// and remove the shim.
const MIN = '22.16.0';
const NATIVE_RESOLVE_HOOKS = '24.15.0';

function parts(version) {
  return String(version).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
}

function atLeast(version, floor) {
  const have = parts(version);
  const need = parts(floor);
  for (let i = 0; i < 3; i++) {
    if (have[i] !== need[i]) return have[i] > need[i];
  }
  return true;
}

function supported(version) {
  return atLeast(version, MIN);
}

function needsResolveShim(version) {
  return !atLeast(version, NATIVE_RESOLVE_HOOKS);
}

function message(version) {
  return `countinghouse 8 needs Node 22.16 or later (this is ${version})`;
}

const NEEDS_RESOLVE_SHIM = needsResolveShim(process.version);

module.exports = {MIN, supported, message, needsResolveShim, NEEDS_RESOLVE_SHIM};
