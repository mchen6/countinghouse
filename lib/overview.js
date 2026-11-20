'use strict';
// countinghouse_overview (B-firstrun: the first-run design, (b); Matt's
// approval 2026-11-20, every fixed sentence through business's claim
// check): what is installed here, what each pack does, example asks, and
// what is still missing, from live state -- read-only, it changes nothing.
//
// build() is the answer from what the gateway gathers for the caller
// (lib/mcp/gateway.js overviewFor): only the packs and tools that caller's
// tools/list can already show (no oracle of what else exists), and, with
// --settingsFile (the single-identity profile), ch-local's install record
// and its held-back modules (lib/held-back.js) for the packs not loaded.
//
// The answer is data, sent as toolCallResult sends one: the JSON as the
// text and as structuredContent. A module's own words are only ever a
// field's value under byTheModule, each one line (a hidden character a
// space, bounded), so no module text can take the shape of the runtime's
// own lines (the high review of #490, 1): every sentence the runtime adds
// is a field of its own (next, notice, scenarios) and fixed (FIXED). Both
// parts together are at most MAX_BYTES as sent -- the structured JSON, and
// the text as a JSON string, its quotes and backslashes escaped again: a pack that does not fit is left
// out (the ones after it still tried) and counted, and a pack's tools are
// at most MAX_TOOLS, the rest counted.
const {moduleLine} = require('./module-text');

const MAX_BYTES = 8 * 1024;
const MAX_TOOLS = 16;
const MAX_EXAMPLES = 4;
const MAX_EXAMPLE = 100;
const MAX_DESCRIPTION = 300;
const GUIDE = 'https://github.com/mchen6/countinghouse/blob/master/docs/module-development.md';
// a command shown for the user's own terminal: the home's launcher when
// ch-local gave one (an npx or folder install puts no ch-local on PATH)
const command = (launcher, args) => (launcher != null ? `node "${launcher}" ${args}` : `ch-local ${args}`);
const FIXED = {
  none: 'No packs are installed.',
  credential: (module, launcher) => `In your own terminal run \`${command(launcher, `credentials add ${module}`)}\`.`,
  notLoaded: (launcher) => `Not loaded: run \`${command(launcher, 'status')}\` in your own terminal to see why.`,
  notLoadedHosted: 'Not loaded on this runtime.',
  recordUnreadable: (launcher) => `The list of installed packs could not be read: run \`${command(launcher, 'status')}\` in your own terminal.`,
  scenarios: `To build a scenario that combines modules, see the module development guide (${GUIDE}).`,
  authoring: 'The authoring tools are enabled for you: countinghouse_validate_plan, countinghouse_validate_module and countinghouse_load_module.'
};
const STATES = ['ready', 'off', 'not loaded'];

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    version: {type: 'string'},
    packs: {type: 'array', items: {type: 'object', properties: {
      name: {type: 'string'},
      module: {type: 'string'},
      state: {type: 'string', enum: STATES},
      tools: {type: 'array', items: {type: 'string'}},
      toolsOmitted: {type: 'integer'},
      byTheModule: {type: 'object', properties: {
        description: {type: 'string'},
        examples: {type: 'array', items: {type: 'string'}}
      }, additionalProperties: false},
      next: {type: 'string'}
    }, required: ['name', 'module', 'state', 'tools'], additionalProperties: false}},
    omitted: {type: 'integer'},
    notice: {type: 'string'},
    scenarios: {type: 'string'}
  },
  required: ['version', 'packs', 'scenarios'],
  additionalProperties: false
};

// One pack: name (the pack, or its module's package where there is no
// record), module (its scenario module's package), loaded, description and
// examples as the module gave them, tools (the caller's shown tool names),
// held (lib/held-back.js's entry, or null)
function packOf({name, module, loaded, description, tools, examples, held}, {settingsProfile, launcher}) {
  const out = {name, module, state: 'ready', tools: []};
  if (loaded) {
    out.tools = tools.slice(0, MAX_TOOLS);
    if (tools.length > MAX_TOOLS) out.toolsOmitted = tools.length - MAX_TOOLS;
    const words = {};
    const d = typeof(description) === 'string' ? moduleLine(description, MAX_DESCRIPTION) : '';
    if (d !== '') words.description = d;
    const asks = [];
    for (const title of examples) {
      if (asks.length >= MAX_EXAMPLES) break;
      const line = typeof(title) === 'string' ? moduleLine(title, MAX_EXAMPLE) : '';
      if (line !== '') asks.push(line);
    }
    if (asks.length > 0) words.examples = asks;
    if (Object.keys(words).length > 0) out.byTheModule = words;
    return out;
  }
  if (held != null && held.reason === 'off') { out.state = 'off'; return out; }
  out.state = 'not loaded';
  // a missing credential: the module's own, or the part's that blocks it
  const needs = held == null ? null : held.reason === 'credential' ? module : (held.reason === 'calls' && held.root === 'credential' ? held.via : null);
  out.next = !settingsProfile ? FIXED.notLoadedHosted : needs != null ? FIXED.credential(needs, launcher) : FIXED.notLoaded(launcher);
  return out;
}

// -> the answer (the structured data; the text is its JSON). One pass: each
// pack added while both parts as sent (sent()) stay within MAX_BYTES, room
// kept for the count of what was left out; one that does not fit is left
// out and the next tried.
const OMITTED_ROOM = 24;
// a value's bytes as sent: its JSON (structuredContent) and that JSON as a
// JSON string (the text, its own quotes left out)
function sent(v) {
  const json = JSON.stringify(v);
  return Buffer.byteLength(json, 'utf8') + Buffer.byteLength(JSON.stringify(json), 'utf8') - 2;
}
function build({version, packs, settingsProfile = false, launcher = null, authoring = false, recordUnreadable = false}) {
  const shownLauncher = settingsProfile ? launcher : null;
  const all = packs.map((p) => packOf(p, {settingsProfile, launcher: shownLauncher}));
  const data = {version: String(version), packs: [], scenarios: authoring ? `${FIXED.scenarios} ${FIXED.authoring}` : FIXED.scenarios};
  if (recordUnreadable && settingsProfile) data.notice = FIXED.recordUnreadable(shownLauncher);
  else if (all.length === 0) data.notice = FIXED.none;
  let used = sent(data) + 2 * OMITTED_ROOM;
  let omitted = 0;
  for (const p of all) {
    const size = sent(p) + 2;   // (and its comma, in each part)
    if (used + size > MAX_BYTES) { omitted++; continue; }
    data.packs.push(p);
    used += size;
  }
  if (omitted > 0) data.omitted = omitted;
  return data;
}

module.exports = {build, sent, OUTPUT_SCHEMA, FIXED, MAX_BYTES, MAX_TOOLS, MAX_EXAMPLES, MAX_EXAMPLE, MAX_DESCRIPTION, GUIDE};
