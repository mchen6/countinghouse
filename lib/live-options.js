'use strict';
// The live settings a worker takes from the main thread ('live-options',
// lib/settings-tool.js broadcastLiveOptions): only these fields, each of its
// own type. A file of its own, loaded at a worker's boot: the settings
// tool's whole closure is the main thread's, and nothing of the runtime's
// loads in a worker after its lockdown (#194's PR 1).
const LIVE_FIELDS = Object.freeze(['maxOutputBytes', 'requestTimeout', 'locale']);
const LOCALES = Object.freeze(['en-US', 'zh-CN']);

// worker: only those fields, each of its own type
function applyLiveOptions(target, sent) {
  if (sent == null || typeof(sent) !== 'object') return;
  for (const k of LIVE_FIELDS) {
    const v = sent[k];
    if (k === 'locale' ? LOCALES.includes(v) : (Number.isInteger(v) && v > 0)) target[k] = v;
  }
}

module.exports = {LIVE_FIELDS, LOCALES, applyLiveOptions};
