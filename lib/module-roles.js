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
const {slugify, serviceLabel} = require('./mcp/tool-name');

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

// The names a module's actions are listed under.
function toolNamesOf(dir, role) {
  const api = apiOf(dir);
  if (api == null || api.device == null || api.device.serviceList == null) return [];
  const device = slugify(api.device.friendlyName || path.basename(dir));
  const names = [];
  for (const [urn, svc] of Object.entries(api.device.serviceList)) {
    for (const action of svc.actionList || []) {
      names.push(role === 'scenario' ? slugify(action.name) : `${device}_${serviceLabel(urn)}_${slugify(action.name)}`);
    }
  }
  return names;
}

// --loadModule's directories -> {load: [{path, name, version, listed}], refused:
// [{name, path, code, part?, tool?, with?}]}, in order: each given module, then
// a scenario's parts after it. `reserved`: the runtime's built-in tool names.
function expandLoadList(dirs, {reserved = []} = {}) {
  const resolvedDirs = [];
  const refused = [];
  const seen = new Map(); // real directory -> entry
  const plan = [];

  // A module and, for a scenario or a part with calls, everything it calls.
  const collect = (dir, listed) => {
    const pkg = packageOf(dir);
    if (pkg == null) return {ok: true, entries: []};
    const real = fs.realpathSync(dir);
    if (seen.has(real)) return {ok: true, entries: []};
    const entry = {path: dir, name: pkg.name, version: pkg.version, listed, role: roleOf(pkg)};
    seen.set(real, entry);
    const entries = [entry];
    if (entry.role === 'scenario' || (entry.role === 'part' && !listed)) {
      for (const part of partsOf(pkg)) {
        const partDir = resolvePart(part, dir);
        if (partDir == null) return {ok: false, part};
        const below = collect(partDir, false);
        if (!below.ok) return below;
        entries.push(...below.entries);
      }
    }
    return {ok: true, entries};
  };

  for (const dir of dirs) {
    const pkg = packageOf(dir);
    if (pkg == null) continue;
    const real = fs.realpathSync(dir);
    if (seen.has(real)) continue;
    const before = new Set(seen.keys());
    const got = collect(dir, true);
    if (!got.ok) {
      for (const k of [...seen.keys()]) if (!before.has(k)) seen.delete(k);
      refused.push({name: pkg.name, path: dir, code: 'PART_MISSING', part: got.part});
      continue;
    }
    plan.push(...got.entries);
    resolvedDirs.push(dir);
  }

  // Names: a scenario's bare names must be free of every listed tool and built-in.
  const taken = new Map(reserved.map((n) => [n, 'a runtime built-in']));
  for (const e of plan.filter((m) => m.listed && m.role !== 'scenario')) for (const n of toolNamesOf(e.path, e.role)) taken.set(n, e.name);
  const load = [];
  const droppedScenarios = new Set();
  for (const e of plan) {
    if (e.listed && e.role === 'scenario') {
      const clash = toolNamesOf(e.path, 'scenario').find((n) => taken.has(n));
      if (clash != null) {
        refused.push({name: e.name, path: e.path, code: 'TOOL_NAME_TAKEN', tool: clash, with: taken.get(clash)});
        droppedScenarios.add(e);
        continue;
      }
      for (const n of toolNamesOf(e.path, 'scenario')) taken.set(n, e.name);
    }
    load.push(e);
  }
  // A refused scenario's parts go with it, unless something else loaded them.
  const owner = new Map();
  let current = null;
  for (const e of plan) { if (e.listed) current = e; owner.set(e, current); }
  return {load: load.filter((e) => e.listed || !droppedScenarios.has(owner.get(e))).map(({path: p, name, version, listed}) => ({path: p, name, version, listed})), refused};
}

module.exports = {roleOf, partsOf, resolvePart, toolNamesOf, expandLoadList};
