'use strict';
// The spec get-spec and /device-list answer, its declared text cleaned as the
// MCP lists show it (the reviewer's rulings on #400's follow-up and #447's
// high review; M18, lib/client-text.js, its hiddenClass rule): a title, a
// question's message and the device's own short fields as one line
// (tools/list, resources/list, prompts/list, a question's dialog); a
// description, the device's modelDescription and a prompt message's text
// as a message (newlines and tabs kept). The device's identifiers
// (deviceID, friendlyName) are not text and stay as declared, as does all
// structure. A copy made by lib/safe-copy.js: the served spec is never
// changed, a "__proto__" key stays a key, and a spec with nothing to clean
// is handed on as it is.
const clientText = require('./client-text');
const {isObject, own, copyWith} = require('./safe-copy');

// a declaration's title and description, cleaned
function texts(o) {
  const changes = {};
  if (typeof(o.title) === 'string') own(changes, 'title', clientText.line(o.title));
  if (typeof(o.description) === 'string') own(changes, 'description', clientText.message(o.description));
  return changes;
}
const mapped = (list, f) => {
  const out = list.map(f);
  return out.every((v, i) => v === list[i]) ? list : out;
};

function action(a) {
  if (!isObject(a)) return a;
  const changes = texts(a);
  if (isObject(a.resource)) own(changes, 'resource', copyWith(a.resource, texts(a.resource)));
  // a question's message, as its dialog is cleaned (lib/module-questions.js: one line)
  if (isObject(a.questions)) {
    const questions = {};
    for (const q of Object.keys(a.questions)) {
      const d = a.questions[q];
      own(questions, q, isObject(d) && typeof(d.message) === 'string' ? copyWith(d, {message: clientText.line(d.message)}) : d);
    }
    own(changes, 'questions', copyWith(a.questions, questions));
  }
  return copyWith(a, changes);
}

function prompt(p) {
  if (!isObject(p)) return p;
  const changes = texts(p);
  if (Array.isArray(p.messages)) {
    own(changes, 'messages', mapped(p.messages, (m) => (isObject(m) && typeof(m.text) === 'string' ? copyWith(m, {text: clientText.message(m.text)}) : m)));
  }
  return copyWith(p, changes);
}

// the device's own fields that are not text (identifiers) or are structure
// (any other string field is free text: cleaned, so text an LLM reads never
// passes raw, the medium review of #447's high round, 9)
const NOT_TEXT = new Set(['deviceID', 'friendlyName', 'deviceType', 'UDN', 'serialNumber', 'manufacturerURL', 'modelURL', 'presentationURL',
  'serviceList', 'promptList', 'deviceList']);
const MESSAGES = new Set(['modelDescription', 'description']);

// spec -> its copy with the declared text cleaned (the spec itself when
// nothing changes); anything else as it is. leaveOut: the names of prompts
// left out of promptList (those prompts/list leaves out:
// lib/mcp/prompts.js hiddenPromptsOf)
function cleanedSpecText(spec, {leaveOut = null} = {}) {
  if (!isObject(spec) || !isObject(spec.device)) return spec;
  const device = spec.device;
  const changes = {};
  for (const k of Object.keys(device)) {
    if (NOT_TEXT.has(k) || typeof(device[k]) !== 'string') continue;
    own(changes, k, MESSAGES.has(k) ? clientText.message(device[k]) : clientText.line(device[k]));
  }
  if (isObject(device.serviceList)) {
    const serviceList = {};
    for (const serviceID of Object.keys(device.serviceList)) {
      const service = device.serviceList[serviceID];
      own(serviceList, serviceID, isObject(service) && Array.isArray(service.actionList)
        ? copyWith(service, {actionList: mapped(service.actionList, action)}) : service);
    }
    own(changes, 'serviceList', copyWith(device.serviceList, serviceList));
  }
  if (Array.isArray(device.promptList)) {
    const kept = leaveOut == null || leaveOut.size === 0 ? device.promptList : device.promptList.filter((p) => !(isObject(p) && leaveOut.has(p.name)));
    own(changes, 'promptList', kept.length === device.promptList.length ? mapped(device.promptList, prompt) : kept.map(prompt));
  }
  // an embedded device's spec, cleaned the same way
  if (Array.isArray(device.deviceList)) {
    own(changes, 'deviceList', mapped(device.deviceList, (d) => (isObject(d) && isObject(d.device) ? cleanedSpecText(d)
      : isObject(d) ? cleanedSpecText({device: d}).device : d)));
  }
  return copyWith(spec, {device: copyWith(device, changes)});
}

module.exports = {cleanedSpecText};
