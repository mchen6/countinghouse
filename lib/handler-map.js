// 6.0.0 module shape: a module exports a plain handler map and the framework
// assembles the device from it, instead of the author writing an index.js that
// emits deviceonline, a device.js that repeats every URN in a setAction call,
// and a _getDeviceRootSchema that reads schema.json by hand.
//
//   module.exports = {
//     echoService: {
//       echo: async (input, ctx) => ({output: input})
//     }
//   };
//
// Top-level keys are service *short* names; api.json is the only place the
// full URN appears. Second-level keys are action names, matched against the
// action `name` fields in api.json's actionList.
//
// Authors who prefer a file per action can instead drop device.js and lay out
//   handlers/<serviceShortName>/<actionName>.js
// with the handler as the default export; loadConventionHandlers below builds
// the same map from that tree.
//
// The old shape (a class/EventEmitter that does discovery) is untouched and
// still supported -- see module-manager.js's loadModuleFromPath for the
// either/or, and docs/design-decisions.md for why the dynamic path stays.
const fs   = require('fs');
const path = require('path');

const SERVICE_URN_SEP = ':serviceID:';

// urn:countinghouse-com:serviceID:echoService -> echoService
// Split on the separator rather than on ':' segments: short names are not
// ASCII-only and are not guaranteed to be a single segment (echo-device-client
// -module ships urn:example-com:serviceID:服务名称).
function shortNameOf(serviceURN) {
  const at = serviceURN.lastIndexOf(SERVICE_URN_SEP);
  if (at === -1) return null;
  return serviceURN.slice(at + SERVICE_URN_SEP.length);
}

// shortName -> [urn, ...]. Kept as a list so an ambiguous short name is
// reported as ambiguous rather than silently resolving to whichever service
// happened to be enumerated last.
function buildServiceIndex(spec) {
  const index = new Map();
  const serviceList = (spec && spec.device && spec.device.serviceList) || {};

  for (const urn of Object.keys(serviceList)) {
    const short = shortNameOf(urn);
    if (short == null) continue;
    if (!index.has(short)) index.set(short, []);
    index.get(short).push(urn);
  }
  return index;
}

function actionNamesOf(serviceSpec) {
  if (serviceSpec == null || !Array.isArray(serviceSpec.actionList)) return [];
  return serviceSpec.actionList
    .map((a) => (a == null ? null : a.name))
    .filter((n) => typeof n === 'string');
}

// A handler map is a plain object whose values are plain objects of functions.
// Deliberately strict: a class or an EventEmitter must fall through to the
// legacy discovery path, and anything else is a mistake worth naming.
function isHandlerMap(exported) {
  if (exported == null || typeof exported !== 'object') return false;
  if (Array.isArray(exported)) return false;
  // a constructor exported as `module.exports = Device` is a function, and an
  // instance of an EventEmitter subclass is an object but not a bare one
  if (Object.getPrototypeOf(exported) !== Object.prototype &&
      Object.getPrototypeOf(exported) !== null) return false;

  const services = Object.values(exported);
  if (services.length === 0) return false;
  return services.every((svc) =>
    svc != null && typeof svc === 'object' && !Array.isArray(svc) &&
    Object.values(svc).every((fn) => typeof fn === 'function'));
}

// Build the same map from handlers/<serviceShortName>/<actionName>.js.
// Returns null when there is no handlers/ directory at all, so the caller can
// tell "not a convention module" apart from "a convention module with nothing
// in it" -- the latter is an error, the former is not.
function loadConventionHandlers(modulePath, requireFile) {
  const root = path.join(modulePath, 'handlers');
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return null;

  const map = {};
  for (const serviceDir of fs.readdirSync(root).sort()) {
    const serviceRoot = path.join(root, serviceDir);
    if (!fs.statSync(serviceRoot).isDirectory()) continue;

    const actions = {};
    for (const file of fs.readdirSync(serviceRoot).sort()) {
      if (!file.endsWith('.js')) continue;
      const actionName = file.slice(0, -('.js'.length));
      const loaded = requireFile(path.join(serviceRoot, file));
      // tolerate both `module.exports = fn` and `export default fn` shapes
      const fn = (loaded != null && typeof loaded.default === 'function') ? loaded.default : loaded;
      actions[actionName] = fn;
    }
    map[serviceDir] = actions;
  }
  return map;
}

// Strict, both directions (design section 3.4). Convention-based assembly makes
// silent mismatches easy to produce, and "a module with an illegal spec just
// disappears" is a defect class this repo has already fixed once; it must not
// come back through a new door.
//
// Collects every problem rather than throwing on the first: an author who
// renamed a service wants the whole list, not one error per restart. Each
// message names the module, the stage, the offending name, and the way out.
function validateHandlerMap(spec, handlerMap, moduleName) {
  const problems = [];
  const stage = 'stage=assembleHandlerMap';
  const index = buildServiceIndex(spec);

  if (!isHandlerMap(handlerMap)) {
    problems.push(`${moduleName}: ${stage} -- the module does not export a handler map. ` +
                  'Expected a plain object of {serviceShortName: {actionName: fn}}. ' +
                  'See docs/module-development.md');
    return problems;
  }

  // direction 1: every handler key must resolve to something declared
  for (const short of Object.keys(handlerMap)) {
    const urns = index.get(short);

    if (urns == null) {
      const known = [...index.keys()].sort().join(', ') || '(none)';
      problems.push(`${moduleName}: ${stage} -- handler map declares service "${short}", ` +
                    `which is not in api.json. Services declared there: ${known}. ` +
                    'Top-level keys are service short names (the part after ":serviceID:" ' +
                    'in the URN), not the full URN.');
      continue;
    }
    if (urns.length > 1) {
      problems.push(`${moduleName}: ${stage} -- service short name "${short}" is ambiguous: ` +
                    `api.json declares it under ${urns.length} URNs (${urns.join(', ')}). ` +
                    'Rename one of them so short names are unique within the module.');
      continue;
    }

    const declared = actionNamesOf(spec.device.serviceList[urns[0]]);
    for (const actionName of Object.keys(handlerMap[short])) {
      if (declared.indexOf(actionName) === -1) {
        problems.push(`${moduleName}: ${stage} -- handler map has "${short}.${actionName}", ` +
                      `which api.json does not declare. Actions declared on ${urns[0]}: ` +
                      `${declared.join(', ') || '(none)'}. Check for a typo, or add the ` +
                      'action to api.json.');
      }
    }
  }

  // direction 2: every declared action must have a handler
  const serviceList = (spec && spec.device && spec.device.serviceList) || {};
  for (const urn of Object.keys(serviceList)) {
    const short = shortNameOf(urn);
    const declared = actionNamesOf(serviceList[urn]);

    if (short == null) {
      problems.push(`${moduleName}: ${stage} -- service URN "${urn}" has no "${SERVICE_URN_SEP}" ` +
                    'segment, so it has no short name a handler map can key on.');
      continue;
    }
    const actions = handlerMap[short];
    if (actions == null) {
      problems.push(`${moduleName}: ${stage} -- api.json declares service "${short}" (${urn}) ` +
                    `with ${declared.length} action(s), but the handler map has no "${short}" key. ` +
                    'Every declared service needs handlers, or the actions can never be called.');
      continue;
    }
    for (const actionName of declared) {
      if (typeof actions[actionName] !== 'function') {
        problems.push(`${moduleName}: ${stage} -- api.json declares action "${short}.${actionName}" ` +
                      `(${urn}), but the handler map has no function for it. Add it, or remove the ` +
                      'action from api.json.');
      }
    }
  }

  return problems;
}

module.exports = {
  SERVICE_URN_SEP:        SERVICE_URN_SEP,
  shortNameOf:            shortNameOf,
  buildServiceIndex:      buildServiceIndex,
  actionNamesOf:          actionNamesOf,
  isHandlerMap:           isHandlerMap,
  loadConventionHandlers: loadConventionHandlers,
  validateHandlerMap:     validateHandlerMap
};
