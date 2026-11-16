'use strict';
// Prompts (MCP completeness M10, spec section 7): the registry behind
// prompts/list and prompts/get. A prompt is a module's declared template
// (its api.json's promptList): prompts/get runs no module code, needs no
// worker, no billing and no timeout, and never asks the user anything.
//
// A caller's prompts are found as its tools are: the listed modules' (an
// unlisted part's never; the single-identity profile's scenarios only) on
// the devices it is granted (tool-registry grantedDevices), in spec order,
// named <device>_<name> -- a scenario's under its bare name -- and deduped
// (_2) within the prompts. A prompt not in a caller's own list is no more
// than an unknown name.
//
// Arguments: a worker-mode runtime never walks a module's schema on its
// main thread. What prompts/list shows of a prompt's arguments was derived
// in a validator at load (lib/module-spec.js prompts: own.prompts), and
// each prompts/get's arguments are checked in one (promptArgs). Single-
// thread mode derives and checks on its own thread, as it compiles every
// schema there (lib/prompt-arguments.js).
const toolRegistry = require('./tool-registry');
const {promptNameFor} = require('./tool-name');
const promptArguments = require('../prompt-arguments');
const moduleSpecLib = require('../module-spec');

// a prompts/get answer's bound, serialized
const MAX_RESULT_BYTES = 64 * 1024;
// a placeholder as the load accepts one (lib/declarations.js PLACEHOLDER_NAME)
const PLACEHOLDER = /\{\{([A-Za-z0-9_.-]{1,64})\}\}/g;

// -> callback(err, [{name, prompt, deviceID, device, module, role}]): the
// caller's prompts, in order. Names are deduped over every listed module's
// prompts before the caller's grants filter them, as tools are: one prompt
// has one name, whoever lists it.
function listEntries(cdifInterface, appKey, callback) {
  toolRegistry.grantedDevices(appKey, (err, granted) => {
    if (err) return callback(err);
    const dm = cdifInterface.deviceManager;
    const specs = dm.getAllDeviceSpecs();
    const used = {};
    const out = [];
    for (const deviceID of Object.keys(specs)) {
      const listing = toolRegistry.listingOf(cdifInterface, deviceID);
      if (!listing.listed) continue;
      const spec = specs[deviceID];
      const module = (spec != null && spec.device != null && spec.device.friendlyName) || deviceID;
      for (const prompt of promptArguments.promptsOf(spec)) {
        const name = toolRegistry.dedupeName(used, promptNameFor(listing.role, module, prompt.name));
        if (granted != null && !granted.has(deviceID)) continue;
        out.push({name, prompt, deviceID, device: dm.deviceMap != null ? dm.deviceMap[deviceID] : null, module, role: listing.role});
      }
    }
    return callback(null, out);
  });
}

// Single-thread mode's derivation, once per device and spec: again when the
// device's spec or schema changes in place. Compiled in a schema validator
// of its own, never the process's shared one, where a schema's $id compiled
// twice (a reload, or the same schema an action uses) would be refused.
function derivedHere(device) {
  const kept = device._promptArguments;
  if (kept != null && kept.spec === device.spec && kept.schemaDoc === device.schemaDoc) return kept.derived;
  const own = {spec: device.spec, schemaDoc: device.schemaDoc, resolveSchemaFromPath: device.resolveSchemaFromPath,
    schemaValidator: require('../validator').createSchemaValidator({logger: {log: () => {}, warn: () => {}, error: () => {}}})};
  const derived = promptArguments.deriveAll(own);
  device._promptArguments = {spec: device.spec, schemaDoc: device.schemaDoc, derived};
  return derived;
}
const workerSpec = (device) => (device != null && device.moduleSpec != null && device.moduleSpec.error == null) ? device.moduleSpec : null;

// -> Promise of the prompt's listed arguments ([{name, description?,
// required}]), or null for none
async function argumentsOf(entry) {
  const own = workerSpec(entry.device);
  if (own != null) return (own.prompts != null && own.prompts[entry.prompt.name] != null) ? own.prompts[entry.prompt.name] : null;
  if (entry.device == null || typeof(entry.device.resolveSchemaFromPath) !== 'function') return null;
  // single-thread mode: a schema that does not derive costs its own
  // prompt's arguments, logged, never the whole list's page
  try {
    const derived = await derivedHere(entry.device);
    const d = derived.get(entry.prompt.name);
    return d != null ? d.arguments : null;
  } catch (e) {
    try { require('../logger').E(e); } catch (_) { /* no logger */ }
    return null;
  }
}

// What prompts/list shows of one: {name, title?, description?, arguments?,
// icons?}, each only when declared (icons from what the load kept, M2).
async function describe(cdifInterface, entry) {
  const p = entry.prompt;
  const out = {name: entry.name};
  if (typeof(p.title) === 'string') out.title = p.title;
  if (typeof(p.description) === 'string') out.description = p.description;
  const args = await argumentsOf(entry);
  if (args != null) out.arguments = args;
  const icons = toolRegistry.inlineIcons(p.icons, toolRegistry.keptIcons(cdifInterface, entry.deviceID));
  if (icons != null) out.icons = icons;
  return out;
}

// -> Promise of {errors: null | [{instancePath, message}]} | {failed} |
// {timeout} | a refusal [error, data] (the caller throttled, the module
// quarantined): the arguments checked against the prompt's schema. caller:
// the opaque caller id, for the validators' per-caller bounds.
async function checkArguments(entry, args, caller = null) {
  const own = workerSpec(entry.device);
  if (own != null) return moduleSpecLib.promptArgs(own, entry.prompt.name, args, caller);
  if (entry.device == null || typeof(entry.device.resolveSchemaFromPath) !== 'function') return {failed: 'no spec'};
  try {
    const derived = await derivedHere(entry.device);
    return {errors: promptArguments.check(derived.get(entry.prompt.name), args)};
  } catch (e) {
    return {failed: (e != null && e.name) || 'Error'};
  }
}

// The answer's messages: each {{name}} replaced once by its argument (an
// absent one is the empty string), in one pass, so substituted text is never
// scanned again. Text in double braces that is no placeholder name is sent
// as written (the load warns about it).
function render(prompt, args) {
  const messages = Array.isArray(prompt.messages) ? prompt.messages : [];
  return messages.filter((m) => m != null && typeof(m.text) === 'string').map((m) => ({
    role: m.role,
    content: {type: 'text', text: m.text.replace(PLACEHOLDER, (whole, name) => (Object.hasOwn(args, name) && typeof(args[name]) === 'string' ? args[name] : ''))}
  }));
}

module.exports = {listEntries, describe, checkArguments, render, MAX_RESULT_BYTES};
