'use strict';
// The live settings a worker takes from the main thread ('live-options',
// lib/settings-tool.js broadcastLiveOptions): only these fields, each of its
// own type. A file of its own, loaded at a worker's boot: the settings
// tool's whole closure is the main thread's, and nothing of the runtime's
// loads in a worker after its lockdown (#194's PR 1).
const LIVE_FIELDS = Object.freeze(['maxOutputBytes', 'requestTimeout', 'locale']);
const LOCALES = Object.freeze(['en-US', 'zh-CN']);

// Taken at load (a worker's boot): this runs in the worker after its
// lockdown, so an operator's tightening (maxOutputBytes, requestTimeout)
// never depends on what module code may have put on an Array iterator,
// Array.prototype.includes or Number.isInteger since (#425's final review).
const NumberIsInteger = Number.isInteger;
const isLocale = (v) => {
  for (let i = 0; i < LOCALES.length; i++) if (LOCALES[i] === v) return true;
  return false;
};

// worker: only those fields, each of its own type
function applyLiveOptions(target, sent) {
  if (sent == null || typeof(sent) !== 'object') return;
  for (let i = 0; i < LIVE_FIELDS.length; i++) {
    const k = LIVE_FIELDS[i];
    const v = sent[k];
    if (k === 'locale' ? isLocale(v) : (NumberIsInteger(v) && v > 0)) target[k] = v;
  }
}

module.exports = {LIVE_FIELDS, LOCALES, applyLiveOptions};
