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
const moduleText = require('./module-text');
const {isObject, own, copyWith} = require('./safe-copy');

// The declared text fields, by kind, and the rule each leaves by (#447's high
// review, 6: one table, read by tools/list, prompts/list and its prompts'
// messages, resources/list, get-spec and /device-list, so they cannot drift
// apart): 'line', one line (lib/module-text.js line: each hidden character a
// space); 'message', newlines and tabs kept (message). The table only
// chooses; the cleaning is module-text's alone. '*' is a kind's rule for
// any other free-text field: only a device has one (one line; its
// identifiers and structure are no text: NOT_TEXT below).
const TEXT_FIELDS = Object.freeze({
  action: Object.freeze({title: 'line', description: 'message'}),
  resource: Object.freeze({title: 'line', description: 'message'}),
  prompt: Object.freeze({title: 'line', description: 'message'}),
  argument: Object.freeze({description: 'message'}),
  // (as a question's dialog shows it: lib/module-questions.js)
  question: Object.freeze({message: 'line'}),
  promptMessage: Object.freeze({text: 'message'}),
  device: Object.freeze({modelDescription: 'message', description: 'message', '*': 'line'})
});
const RULES = Object.freeze({line: moduleText.line, message: moduleText.message});

// a kind's fields, or a throw for a kind the table has not
function fieldsOf(kind) {
  if (!Object.hasOwn(TEXT_FIELDS, kind)) throw new Error(`no declared text kind ${kind}`);
  return TEXT_FIELDS[kind];
}

// a declared text field's value as it leaves (a string)
function cleanText(kind, field, value) {
  const fields = fieldsOf(kind);
  const rule = Object.hasOwn(fields, field) && field !== '*' ? fields[field] : (Object.hasOwn(fields, '*') ? fields['*'] : null);
  if (rule == null) throw new Error(`no declared text field ${kind}.${field}`);
  return RULES[rule](value);
}

// o's own string fields named in the kind's table, cleaned: -> {field:
// text}, each one present only ('*' names none)
function cleanedFields(kind, o) {
  const changes = {};
  for (const field of Object.keys(fieldsOf(kind))) {
    if (field !== '*' && Object.hasOwn(o, field) && typeof(o[field]) === 'string') own(changes, field, cleanText(kind, field, o[field]));
  }
  return changes;
}
const mapped = (list, f) => {
  const out = list.map(f);
  return out.every((v, i) => v === list[i]) ? list : out;
};

function action(a) {
  if (!isObject(a)) return a;
  const changes = cleanedFields('action', a);
  if (isObject(a.resource)) own(changes, 'resource', copyWith(a.resource, cleanedFields('resource', a.resource)));
  // a question's message, as its dialog is cleaned (lib/module-questions.js: one line)
  if (isObject(a.questions)) {
    const questions = {};
    for (const q of Object.keys(a.questions)) {
      const d = a.questions[q];
      own(questions, q, isObject(d) ? copyWith(d, cleanedFields('question', d)) : d);
    }
    own(changes, 'questions', copyWith(a.questions, questions));
  }
  return copyWith(a, changes);
}

function prompt(p) {
  if (!isObject(p)) return p;
  const changes = cleanedFields('prompt', p);
  if (Array.isArray(p.messages)) {
    own(changes, 'messages', mapped(p.messages, (m) => (isObject(m) ? copyWith(m, cleanedFields('promptMessage', m)) : m)));
  }
  return copyWith(p, changes);
}

// the device's own fields that are not text (identifiers) or are structure
// (any other string field is free text: cleaned, so text an LLM reads never
// passes raw, the medium review of #447's high round, 9)
const NOT_TEXT = new Set(['deviceID', 'friendlyName', 'deviceType', 'UDN', 'serialNumber', 'manufacturerURL', 'modelURL', 'presentationURL',
  'serviceList', 'promptList', 'deviceList']);

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
    own(changes, k, cleanText('device', k, device[k]));
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

module.exports = {cleanedSpecText, cleanText, cleanedFields, TEXT_FIELDS};
