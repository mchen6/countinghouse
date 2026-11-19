'use strict';
// The spec get-spec answers, its declared text cleaned as the MCP lists show
// it (the reviewer's ruling on #400's follow-up; M18, lib/client-text.js):
// a title as one line (tools/list, resources/list, prompts/list), a
// description and a prompt message's text as a message (newlines and tabs
// kept). Text only, never structure. A copy: the spec the runtime serves is
// never changed, and each key is defined, never assigned, so a "__proto__"
// key stays a key (as withoutUnusable copies).
const clientText = require('./client-text');

const isObject = (v) => v != null && typeof(v) === 'object' && !Array.isArray(v);
const own = (o, k, v) => Object.defineProperty(o, k, {value: v, writable: true, enumerable: true, configurable: true});

// obj's own enumerable keys, with `changes` in place of theirs
function copyWith(obj, changes) {
  const out = {};
  for (const k of Object.keys(obj)) own(out, k, Object.hasOwn(changes, k) ? changes[k] : obj[k]);
  return out;
}
// a declaration's title and description, cleaned
function texts(o) {
  const changes = {};
  if (typeof(o.title) === 'string') own(changes, 'title', clientText.line(o.title));
  if (typeof(o.description) === 'string') own(changes, 'description', clientText.message(o.description));
  return changes;
}

function action(a) {
  if (!isObject(a)) return a;
  const changes = texts(a);
  if (isObject(a.resource)) own(changes, 'resource', copyWith(a.resource, texts(a.resource)));
  return copyWith(a, changes);
}

function prompt(p) {
  if (!isObject(p)) return p;
  const changes = texts(p);
  if (Array.isArray(p.messages)) {
    own(changes, 'messages', p.messages.map((m) => (isObject(m) && typeof(m.text) === 'string' ? copyWith(m, {text: clientText.message(m.text)}) : m)));
  }
  return copyWith(p, changes);
}

// spec -> a copy whose declared text is cleaned; anything else as it is
function cleanedSpecText(spec) {
  if (!isObject(spec) || !isObject(spec.device)) return spec;
  const device = spec.device;
  const changes = {};
  if (isObject(device.serviceList)) {
    const serviceList = {};
    for (const serviceID of Object.keys(device.serviceList)) {
      const service = device.serviceList[serviceID];
      own(serviceList, serviceID, isObject(service) && Array.isArray(service.actionList)
        ? copyWith(service, {actionList: service.actionList.map(action)}) : service);
    }
    own(changes, 'serviceList', serviceList);
  }
  if (Array.isArray(device.promptList)) own(changes, 'promptList', device.promptList.map(prompt));
  return copyWith(spec, {device: copyWith(device, changes)});
}

module.exports = {cleanedSpecText};
