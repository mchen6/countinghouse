// Checks a proposed service/action split before any file exists.
//
// The value is not that it catches things lib/module-validator.js would miss
// -- it catches a subset, earlier. An agent that has already written four
// files and then learns the tool name collides has wasted the write; an agent
// that learns it from a plan has not. It also gives the user something short
// and readable to approve before code appears, which is where requirement
// analysis actually belongs.
//
// Requires only tool-name.js and call-address.js, never mcp/tool-registry.js:
// that module opens a Redis socket and a timer at require time, which would
// keep this validator's test process alive. call-address.js is safe here --
// it is requireless by design apart from uuid-1345.
const slugify     = require('./mcp/tool-name').slugify;
const callAddress = require('./call-address');

function problem(message, fix) {
  return {stage: 'validatePlan', module: null, message: message, fix: fix || null};
}

// Checks plan.calls, an optional array of composition addresses (the same
// shape as package.json's countinghouse.calls) the plan intends to declare.
// An address is always checked for shape and for duplicates within the
// plan. Whether it resolves to something real can only be checked when the
// caller passes `specs` -- the live deviceID -> device-spec map
// DeviceManager.prototype.getAllDeviceSpecs() produces -- because that is
// the only place loaded devices are visible; this file must not require
// device-manager.js itself (see header). When `specs` is omitted,
// resolution is skipped entirely so existing callers and tests are
// unaffected.
//
// Deliberately NOT lib/mcp/tool-registry.js's buildToolTargets: that helper
// SKIPS any action with no "description" (mandatory for MCP tool exposure,
// but irrelevant to ctx.call, which resolves through the device spec
// directly). Checking plan.calls against it told an author a perfectly
// callable, just undocumented, address "does not match any tool currently
// loaded" -- resolving against the raw specs instead means an address is
// only reported unresolved when it truly does not exist.
//
// A spec matches an address when all three hold: the address's device name
// hashes (callAddress.deviceIDForName) to a key in `specs`, one of that
// device's serviceList URNs has the address's service label as its RAW
// last colon-segment (never slugified -- slugify is lossy and would let
// two different labels match), and that service's actionList has an entry
// whose name equals the address's action.
function callsProblems(plan, specs) {
  const problems = [];
  const calls = (plan != null) ? plan.calls : null;
  if (calls == null) return problems;

  if (!Array.isArray(calls)) {
    problems.push(problem('plan.calls must be an array of composition address strings.',
      `Each entry names a target this module may call, in ${callAddress.ADDRESS_FORM} form.`));
    return problems;
  }

  const seenAddresses = {};

  calls.forEach((address) => {
    const parsed = callAddress.parseAddress(address);
    if (parsed == null) {
      problems.push(problem(
        `"${address}" is not a valid composition address -- expected ${callAddress.ADDRESS_FORM}.`,
        null));
      return;
    }

    // Mirrors lib/module-validator.js's duplicate check on the same
    // "countinghouse.calls" shape -- a plan that passes validate_plan must
    // not then fail validate_module on the identical list.
    if (seenAddresses[address] === true) {
      problems.push(problem(
        `plan.calls lists "${address}" more than once.`,
        'Remove the duplicate entry.'));
    }
    seenAddresses[address] = true;

    if (specs == null) return;

    const deviceID = callAddress.deviceIDForName(parsed.device);
    const spec = specs[deviceID];
    const serviceList = (spec != null && spec.device != null) ? spec.device.serviceList : null;

    const matched = (serviceList != null) && Object.keys(serviceList).some((serviceURN) => {
      if (serviceURN.split(':').pop() !== parsed.service) return false;
      const actionList = serviceList[serviceURN].actionList;
      return Array.isArray(actionList) && actionList.some((action) => action.name === parsed.action);
    });

    if (!matched) {
      problems.push(problem(
        `"${address}" does not match any tool currently loaded on this runtime.`,
        'Check the module, service and action names, or load the target module first.'));
    }
  });

  return problems;
}

// Mirrors how tool-registry names a device tool, so the names reported here
// are the names that will actually appear in tools/list.
function predictedToolName(deviceName, serviceName, actionName) {
  return [slugify(deviceName), slugify(serviceName), slugify(actionName)].join('_');
}

function validatePlan(plan, existingToolNames, specs) {
  const problems = [];
  const existing = existingToolNames || [];
  const toolNames = [];

  callsProblems(plan, specs).forEach((p) => problems.push(p));

  if (plan == null || typeof(plan.device) !== 'string' || plan.device === '') {
    problems.push(problem('plan.device must be a non-empty string.',
                          'This becomes the device friendlyName in api.json.'));
    return {ok: false, problems: problems, toolNames: toolNames};
  }

  if (!Array.isArray(plan.services) || plan.services.length === 0) {
    problems.push(problem('plan.services must be a non-empty array.',
                          'A module exposes at least one service, each with at least one action.'));
    return {ok: false, problems: problems, toolNames: toolNames};
  }

  const seenServices = {};

  plan.services.forEach((svc, i) => {
    if (svc == null || typeof(svc.name) !== 'string' || svc.name === '') {
      problems.push(problem(`services[${i}].name must be a non-empty string.`, null));
      return;
    }
    if (seenServices[svc.name] === true) {
      problems.push(problem(`service short name "${svc.name}" is duplicate within this plan.`,
                            'Short names must be unique within a module -- the handler map keys off them.'));
    }
    seenServices[svc.name] = true;

    if (!Array.isArray(svc.actions) || svc.actions.length === 0) {
      problems.push(problem(`service "${svc.name}" declares no actions.`, null));
      return;
    }

    const seenActions = {};
    svc.actions.forEach((action, j) => {
      if (action == null || typeof(action.name) !== 'string' || action.name === '') {
        problems.push(problem(`services[${i}].actions[${j}].name must be a non-empty string.`, null));
        return;
      }
      if (seenActions[action.name] === true) {
        problems.push(problem(`action "${svc.name}.${action.name}" is declared twice.`,
                              'Action names are unique per service.'));
      }
      seenActions[action.name] = true;

      if (typeof(action.description) !== 'string' || action.description === '') {
        problems.push(problem(`action "${svc.name}.${action.name}" has no description.`,
                              'description is what an LLM reads as the MCP tool description; ' +
                              'an action without one is skipped when tools/list is built.'));
      }

      const toolName = predictedToolName(plan.device, svc.name, action.name);
      toolNames.push(toolName);
      if (existing.indexOf(toolName) !== -1) {
        problems.push(problem(`"${toolName}" is already a tool on this runtime.`,
                              'Rename the device, service or action so the generated tool name is unique.'));
      }
    });
  });

  return {ok: problems.length === 0, problems: problems, toolNames: toolNames};
}

module.exports = {
  validatePlan: validatePlan
};
