// A module's spec on the main thread (lean worker, step 1(b):
// docs/superpowers/specs/2026-11-13-lean-worker-design.md section 4, as the
// reviewer revised it on #152, 2026-11-13).
//
// Read once per worker start, before the worker starts, from the module's own
// api.json and schema.json. The main thread keeps only what is cheap and
// structural: the device ID, the spec as text, the names of its services and
// actions (own names: a name only Object.prototype has is not one), and a
// hash of schema.json. It never compiles or walks a schema: JSON Schema
// validation of a module-authored schema cannot be bounded by any check made
// beforehand, so the schemas go, as text, to the validator pool
// (lib/validator-pool.js), which compiles them in a validator worker, under a
// deadline, on their first use.
//
// Every call the main thread sends to a module's worker (a client's call, a
// job's run, a hop routed through the main thread: lib/device-manager.js's
// sendCounted) is checked: here for its service, action and input's
// presence, then in a validator for its input, before the invoke is sent,
// and for its output on the reply. No module code runs in a validator, so a
// module cannot switch these checks off. The module's worker is told the call
// was checked (mainChecked) and skips its own validation; a direct peer
// channel's call does not pass here, and is still validated in the called
// worker (until step 4).
//
// The device the gateway lists is this spec: a worker's announcement is
// registered only if it matches it (matches), and then as this copy.
const fs          = require('fs');
const path        = require('path');
const crypto      = require('crypto');
const callAddress = require('./call-address');
const {CountinghouseError} = require('./countinghouse-error');

const hasOwn = (object, key) => object != null && Object.hasOwn(object, key);
const hashOf = (text) => (text == null) ? null : crypto.createHash('sha256').update(text).digest('hex');
let nextKey = 1;

// The pool, required on first use: a server-free caller of the structural
// parts never starts a validator.
const pool = () => require('./validator-pool').pool();

// The structural spec of `spec` (api.json, parsed) and schema.json's text:
// {deviceID, spec, specText, schemaHash, names, key, name, ...}, or {error}.
function fromText(spec, schemaText, name, modulePath) {
  try {
    const apiText = JSON.stringify(spec);
    const deviceID = callAddress.deviceIDForName(spec.device.friendlyName);
    // As CHDevice's constructor does, so the copy registered is the spec a
    // worker announces.
    spec.device.deviceID = deviceID;
    const names = Object.create(null);
    const serviceList = spec.device.serviceList;
    for (const serviceID in serviceList) {
      if (!hasOwn(serviceList, serviceID)) continue;
      const actions = new Set();
      const list = (serviceList[serviceID] != null && Array.isArray(serviceList[serviceID].actionList)) ? serviceList[serviceID].actionList : [];
      for (const action of list) if (action != null && typeof(action.name) === 'string') actions.add(action.name);
      names[serviceID] = actions;
    }
    return {deviceID: deviceID, spec: spec, specText: JSON.stringify(spec), schemaHash: hashOf(schemaText), names: names,
      key: `${String(name)}#${nextKey++}`, name: String(name), modulePath: modulePath, apiText: apiText, schemaText: schemaText};
  } catch (e) {
    return {error: e.message};
  }
}

// As fromText, from a parsed schema (tests); resolves.
function fromParts(spec, schemaDoc, name) {
  const named = name || (spec != null && spec.device != null ? spec.device.friendlyName : 'module');
  return Promise.resolve(fromText(spec, schemaDoc == null ? null : JSON.stringify(schemaDoc), named, null));
}

// A module directory's spec, read from its api.json and schema.json (absent
// is legal, as in a worker), and registered with the validator pool under a
// key of its own (one per start). A spec it cannot read resolves {error},
// and the module's device is then never registered (its worker fails the
// same files with its own error).
function build(modulePath, name) {
  let spec = null;
  let schemaText = null;
  try {
    spec = JSON.parse(fs.readFileSync(path.join(modulePath, 'api.json')).toString());
    const schemaPath = path.join(modulePath, 'schema.json');
    if (fs.existsSync(schemaPath)) schemaText = fs.readFileSync(schemaPath).toString();
  } catch (e) {
    return Promise.resolve({error: e.message});
  }
  const own = fromText(spec, schemaText, name || path.basename(String(modulePath)), modulePath);
  if (own.error == null) register(own);
  return Promise.resolve(own);
}

// Gives a spec's files to the validator pool (build does; a test may).
function register(own) {
  pool().register(own.key, own.name, own.apiText, own.schemaText);
}

// The schema-safety check (lib/schema-safety.js) for a built spec, run in a
// validator: null, a problem ({path, reason}), or {timeout: error}.
function safety(own) {
  if (own == null || own.error != null) return Promise.resolve(null);
  return pool().safety(own.key);
}

// Every action of a built spec compiled in a validator at load, under the
// compile budget (--validationCompileMs): null, or a reason to refuse the
// load (lib/validator-pool.js warm).
function warm(own) {
  if (own == null || own.error != null) return Promise.resolve(null);
  return pool().warm(own.key);
}

// An operator's load of the module ends its quarantine (lib/validator-pool.js).
function clearQuarantine(name) {
  pool().clearQuarantine(String(name));
}

// The spec is no longer used (its worker ended): the validators drop it.
function release(own) {
  if (own != null && own.key != null && own.error == null) pool().forget(own.key);
}

// Whether a worker's announced device is this spec's: the same device ID,
// the same spec, as text, and the same schema.json, by hash, read again now
// (LOW-7). A worker reads the same files, so a difference means they changed
// between the reads, or module code changed what its worker announces.
function matches(own, deviceID, announced) {
  if (own == null || own.error != null || own.deviceID !== deviceID) return false;
  try {
    if (JSON.stringify(announced) !== own.specText) return false;
    if (own.modulePath == null) return true;
    const schemaPath = path.join(own.modulePath, 'schema.json');
    const now = fs.existsSync(schemaPath) ? fs.readFileSync(schemaPath).toString() : null;
    return hashOf(now) === own.schemaHash;
  } catch (e) {
    return false;
  }
}

// The answer to a call that fails its checks, as a worker's reply carries it
// (CountinghouseError.replyFields, then fromReplyFields): so a refusal made
// here and one made in a worker reach every caller the same.
function asReply(refused) {
  return [CountinghouseError.fromReplyFields(CountinghouseError.replyFields(refused[0])), refused[1]];
}

// The structural checks before a call is sent to a worker, in the order a
// worker checks: the service, the action, an input at all (own names: a
// service or action named like an Object.prototype member is not found).
// The input itself is checked next, in a validator (validate). Answers:
//   {refused: [error, data]}  the call's answer, as a reply carries it;
//   {key, ...}                validate the input, then send it;
//   null                      no spec for this device: send it as before, and
//                             the worker checks it.
function checkInput(own, deviceID, serviceID, actionName, args) {
  if (own == null || own.error != null || own.deviceID !== deviceID) return null;
  if (!hasOwn(own.names, serviceID)) return {refused: asReply([new CountinghouseError('SERVICE_NOT_FOUND', serviceID), null])};
  if (!own.names[serviceID].has(actionName)) return {refused: asReply([new CountinghouseError('ACTION_NOT_FOUND', actionName), null])};
  if (args == null) return {refused: asReply([new CountinghouseError('INPUT_NOT_FOUND'), null])};
  return {key: own.key, serviceID: serviceID, actionName: actionName};
}

// One side of a checked call, validated in a validator: a promise of null
// (it passes) or the call's answer [error, data].
function validate(checked, which, value) {
  return pool().check(checked.key, checked.serviceID, checked.actionName, which, value);
}

// A hop's result as v8.serialize bytes (lean worker step 2): checked in a
// validator, never deserialised here. -> Promise of {refused, buffer}
// (lib/validator-pool.js checkSerialized).
function validateSerialized(checked, which, buffer) {
  return pool().checkSerialized(checked.key, checked.serviceID, checked.actionName, which, buffer);
}

module.exports = {build, fromParts, fromText, register, safety, warm, clearQuarantine, release, matches, checkInput, validate, validateSerialized, hashOf};
