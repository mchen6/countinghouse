// Roles, scenarios and parts (local-mode spec §3). package.json
// countinghouse.role is "scenario" or "part"; absent, the module is listed as
// every module is today. --loadModule <dir> of a scenario also loads every
// module named (before the slash) in its countinghouse.calls, found from the
// scenario's own directory, recursively for parts that call parts, each module
// once, the parts unlisted. A part loaded directly stays listed, so a part can
// be exercised alone.
//
// A scenario lists its actions under their bare names (ci_failure_triage);
// every other listed module keeps the long form <device>_<service>_<action>
// (reviewer, 2026-11-11). A scenario is not loaded when one of its parts is
// missing (PART_MISSING) or when one of its bare names is already a listed
// tool's or a runtime built-in's (TOOL_NAME_TAKEN). Other modules load normally.
//
// Pure: it reads package.json and api.json files and decides; the module
// manager loads what it returns.
const fs = require('fs');
const path = require('path');
const {toolNameFor} = require('./mcp/tool-name');

const ROLES = ['scenario', 'part'];

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; } };
const packageOf = (dir) => readJson(path.join(dir, 'package.json'));
const apiOf = (dir) => readJson(path.join(dir, 'api.json'));
const friendlyNameOf = (dir) => { const api = apiOf(dir); return api != null && api.device != null ? api.device.friendlyName : null; };

function roleOf(pkg) {
  const role = pkg != null && pkg.countinghouse != null ? pkg.countinghouse.role : null;
  return ROLES.includes(role) ? role : null;
}

// The modules a package calls: the names before the slash in its countinghouse.calls, each once.
function partsOf(pkg) {
  const calls = pkg != null && pkg.countinghouse != null && Array.isArray(pkg.countinghouse.calls) ? pkg.countinghouse.calls : [];
  return [...new Set(calls.filter((c) => typeof c === 'string' && c.includes('/')).map((c) => c.slice(0, c.indexOf('/'))))];
}

// A part's directory, from the calling module's directory: the package of that
// name, or of that name under any npm scope (parts are published scoped:
// @countinghouse/ch-step-redact is called as ch-step-redact), on Node's own
// node_modules search path; only one whose api.json is that module counts.
function resolvePart(name, fromDir) {
  const candidates = [];
  try { candidates.push(path.dirname(require.resolve(`${name}/package.json`, {paths: [fromDir]}))); } catch (_) { /* not under its bare name */ }
  for (const nm of nodeModulesFrom(fromDir)) {
    let entries = [];
    try { entries = fs.readdirSync(nm); } catch (_) { continue; }
    for (const scope of entries.filter((e) => e.startsWith('@'))) candidates.push(path.join(nm, scope, name));
  }
  return candidates.find((dir) => fs.existsSync(path.join(dir, 'package.json')) && friendlyNameOf(dir) === name) || null;
}

// Every node_modules directory Node would search from `dir`: one per ancestor
// that is not itself a node_modules directory.
function nodeModulesFrom(dir) {
  const out = [];
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (path.basename(d) !== 'node_modules') out.push(path.join(d, 'node_modules'));
    if (path.dirname(d) === d) return out;
  }
}

// The names a module's actions are listed under (lib/mcp/tool-name.js
// toolNameFor, as the registry names them). An action with no description is
// never listed, so it takes no name.
function toolNamesOf(dir, role) {
  const api = apiOf(dir);
  if (api == null || api.device == null || api.device.serviceList == null) return [];
  const device = api.device.friendlyName || path.basename(dir);
  const names = [];
  for (const [urn, svc] of Object.entries(api.device.serviceList)) {
    for (const action of svc.actionList || []) {
      if (typeof action.description !== 'string' || action.description.trim() === '') continue;
      names.push(toolNameFor(role, device, urn, action.name));
    }
  }
  return names;
}

// One given module's closure: itself and, recursively, every module it
// calls (a scenario's or a part's countinghouse.calls), each once ->
// {ok: true, modules: [{dir, real, pkg}]} | {ok: false, part}.
function closureOf(dir) {
  const visited = new Map();
  const walk = (d) => {
    const real = fs.realpathSync(d);
    if (visited.has(real)) return null;
    const pkg = packageOf(d);
    visited.set(real, {dir: d, real, pkg});
    if (roleOf(pkg) == null) return null;
    for (const part of partsOf(pkg)) {
      const partDir = resolvePart(part, d);
      if (partDir == null) return part;
      const missing = walk(partDir);
      if (missing != null) return missing;
    }
    return null;
  };
  const missing = walk(dir);
  return missing != null ? {ok: false, part: missing} : {ok: true, modules: [...visited.values()]};
}

// --loadModule's directories -> {load: [{path, name, version, listed}], refused:
// [{name, path, code, part?, tool?, with?}]}. Each given module brings its
// closure; a module given directly is listed whatever the order, a module
// only some given module calls is not. A scenario with a part missing anywhere
// in its closure (PART_MISSING), or whose bare tool name is a listed tool's, a
// built-in's or an earlier scenario's (TOOL_NAME_TAKEN), is refused with its
// closure, except what an accepted module's closure also holds.
// `reserved`: the runtime's built-in tool names.
function expandLoadList(dirs, {reserved = []} = {}) {
  const refused = [];
  const given = [];
  const seenGiven = new Set();
  for (const dir of dirs) {
    const pkg = packageOf(dir);
    if (pkg == null) continue;
    const real = fs.realpathSync(dir);
    if (seenGiven.has(real)) continue;
    seenGiven.add(real);
    const closure = closureOf(dir);
    if (!closure.ok) { refused.push({name: pkg.name, path: dir, code: 'PART_MISSING', part: closure.part}); continue; }
    given.push({dir, real, pkg, role: roleOf(pkg), modules: closure.modules});
  }

  // Bare names: free of every listed non-scenario tool, every built-in, and every earlier scenario.
  const taken = new Map(reserved.map((n) => [n, 'a runtime built-in']));
  for (const g of given.filter((x) => x.role !== 'scenario')) for (const n of toolNamesOf(g.dir, g.role)) taken.set(n, g.pkg.name);
  const accepted = [];
  for (const g of given) {
    if (g.role === 'scenario') {
      const names = toolNamesOf(g.dir, 'scenario');
      const clash = names.find((n) => taken.has(n));
      if (clash != null) { refused.push({name: g.pkg.name, path: g.dir, code: 'TOOL_NAME_TAKEN', tool: clash, with: taken.get(clash)}); continue; }
      for (const n of names) taken.set(n, g.pkg.name);
    }
    accepted.push(g);
  }

  const listedReal = new Set(accepted.map((g) => g.real));
  const load = [];
  const placed = new Set();
  for (const g of accepted) {
    for (const m of g.modules) {
      if (placed.has(m.real)) continue;
      placed.add(m.real);
      load.push({path: m.dir, name: m.pkg.name, version: m.pkg.version, listed: listedReal.has(m.real)});
    }
  }
  return {load, refused};
}

module.exports = {roleOf, partsOf, resolvePart, toolNamesOf, expandLoadList};
