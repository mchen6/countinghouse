'use strict';
// declared text as it leaves for the client (M18)
const clientText = require('../client-text');
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
// the modules going on or off, listed to no one (main thread only)
const visibility = require('../module-visibility');

// a prompts/get answer's bound, serialized
const MAX_RESULT_BYTES = 64 * 1024;
// a placeholder as the load accepts one (lib/declarations.js PLACEHOLDER_NAME)
const PLACEHOLDER = /\{\{([A-Za-z0-9_.-]{1,64})\}\}/g;

// -> callback(err, [{name, prompt, deviceID, device, module, role}]): the
// caller's prompts, in order. Names are deduped over every listed module's
// prompts before the caller's grants filter them, as tools are: one prompt
// has one name, whoever lists it. Every session sees the same prompts (no
// session has a view of its own: #413 section 5.4); a module going on or
// off shows none, as its tools.
function listEntries(cdifInterface, appKey, callback) {
  toolRegistry.grantedDevices(appKey, (err, granted) => {
    if (err) return callback(err);
    const dm = cdifInterface.deviceManager;
    const specs = dm.getAllDeviceSpecs();
    const used = {};
    const out = [];
    // a module going on or off is listed to no one (#413 section 5.5)
    const filtered = !visibility.none();
    for (const deviceID of Object.keys(specs)) {
      const listing = toolRegistry.listingOf(cdifInterface, deviceID);
      if (!listing.listed) continue;
      const spec = specs[deviceID];
      const module = (spec != null && spec.device != null && spec.device.friendlyName) || deviceID;
      for (const prompt of promptArguments.promptsOf(spec)) {
        const name = toolRegistry.dedupeName(used, promptNameFor(listing.role, module, prompt.name));
        if (granted != null && !granted.has(deviceID)) continue;
        if (filtered && !visibility.listsDevice(deviceID)) continue;
        out.push({name, prompt, deviceID, device: dm.deviceMap != null ? dm.deviceMap[deviceID] : null, module, role: listing.role});
      }
    }
    // a prompt one of whose arguments is named with a hidden character is
    // left out (M18): the client sends the name back, so it can't be
    // cleaned; the load's warning names it
    Promise.all(out.map((e) => argumentsOf(e).then((args) => args == null || !args.some((a) => clientText.hasHidden(a.name)), () => true)))
      .then((shown) => setImmediate(callback, null, out.filter((e, i) => shown[i])));
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

// -> Promise of what the load derived for one prompt: field 'arguments'
// (worker mode's record keeps them as own.prompts) or 'candidates'
// (own.completions); null when there is none. Never a walk of the module's
// schema on a worker-mode runtime's main thread; in single-thread mode
// derived here, and a derivation that fails rejects.
const RECORD = {arguments: 'prompts', candidates: 'completions'};
async function derivedOf(entry, field) {
  const own = workerSpec(entry.device);
  if (own != null) {
    const kept = own[RECORD[field]];
    return (kept != null && Object.hasOwn(kept, entry.prompt.name) && kept[entry.prompt.name] != null) ? kept[entry.prompt.name] : null;
  }
  if (entry.device == null || typeof(entry.device.resolveSchemaFromPath) !== 'function') return null;
  const d = (await derivedHere(entry.device)).get(entry.prompt.name);
  return d != null && d[field] != null ? d[field] : null;
}

// -> Promise of the prompt's listed arguments ([{name, description?,
// required}]), or null for none
async function argumentsOf(entry) {
  // single-thread mode: a schema that does not derive costs its own
  // prompt's arguments, logged, never the whole list's page
  try {
    return await derivedOf(entry, 'arguments');
  } catch (e) {
    try { require('../logger').E(e); } catch (_) { /* no logger */ }
    return null;
  }
}

// -> Promise of the completion candidates for one of the prompt's arguments
// (M11: its schema's enum, then its examples, as the load derived them), or
// null when the prompt has no such argument. Rejects when single-thread
// mode's derivation fails: the server's failure, not an unknown argument.
async function candidatesOf(entry, argument) {
  const all = await derivedOf(entry, 'candidates');
  if (all == null || typeof(argument) !== 'string' || !Object.hasOwn(all, argument)) return null;
  return Array.isArray(all[argument]) ? all[argument] : [];
}

// What prompts/list shows of one: {name, title?, description?, arguments?,
// icons?}, each only when declared (icons from what the load kept, M2).
async function describe(cdifInterface, entry) {
  const p = entry.prompt;
  const out = {name: entry.name};
  // declared text, cleaned as it leaves (M18, lib/client-text.js)
  if (typeof(p.title) === 'string') out.title = clientText.line(p.title);
  if (typeof(p.description) === 'string') out.description = clientText.message(p.description);
  const args = await argumentsOf(entry);
  if (args != null) out.arguments = args.map((a) => (typeof(a.description) === 'string' ? Object.assign({}, a, {description: clientText.message(a.description)}) : a));
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

// Whether the messages' text, every {{name}} replaced, would exceed `limit`
// bytes (UTF-8), measured without building any of it: each message's text
// less its placeholders, plus each placeholder's argument. It stops as soon
// as the bound is passed. The serialized answer is at least this many bytes,
// so a request over it is refused before its arguments are checked or its
// text built (the review of #321: a large argument in many placeholders
// would otherwise build tens of MB on the main thread, or throw).
function overBound(prompt, args, limit) {
  const messages = Array.isArray(prompt.messages) ? prompt.messages : [];
  const argBytes = new Map();
  const bytesOf = (name) => {
    if (!argBytes.has(name)) argBytes.set(name, (Object.hasOwn(args, name) && typeof(args[name]) === 'string') ? Buffer.byteLength(args[name]) : 0);
    return argBytes.get(name);
  };
  let total = 0;
  for (const m of messages) {
    if (m == null || typeof(m.text) !== 'string') continue;
    total += Buffer.byteLength(m.text);
    for (const match of m.text.matchAll(PLACEHOLDER)) {
      total += bytesOf(match[1]) - Buffer.byteLength(match[0]);
      if (total > limit) return true;
    }
    if (total > limit) return true;
  }
  return false;
}

// The answer's messages: each {{name}} replaced once by its argument (an
// absent one is the empty string), in one pass, so substituted text is never
// scanned again. Text in double braces that is no placeholder name is sent
// as written (the load warns about it). The declared text is cleaned first
// (M18, lib/client-text.js: its \n and \t kept), and the client's own
// arguments go in as it sent them.
function render(prompt, args) {
  const messages = Array.isArray(prompt.messages) ? prompt.messages : [];
  return messages.filter((m) => m != null && typeof(m.text) === 'string').map((m) => ({
    role: m.role,
    content: {type: 'text', text: clientText.message(m.text).replace(PLACEHOLDER, (whole, name) => (Object.hasOwn(args, name) && typeof(args[name]) === 'string' ? args[name] : ''))}
  }));
}

module.exports = {listEntries, describe, checkArguments, candidatesOf, overBound, render, MAX_RESULT_BYTES};
