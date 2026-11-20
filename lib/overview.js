'use strict';
// countinghouse_overview (B-firstrun: the first-run design, (b); Matt's
// approval 2026-11-20, every fixed sentence through business's claim
// check): what is installed here, what each pack does, example asks, and
// what is still missing, from live state -- read-only, it changes nothing.
//
// build() is the answer from what the gateway gathers for the caller
// (lib/mcp/gateway.js): only the packs and tools that caller's tools/list
// can already show (no oracle of what else exists), and, with --settingsFile
// (the single-identity profile), ch-local's install record and its
// held-back modules (lib/held-back.js) for the packs that are not loaded.
// Every module-supplied string is cleaned as module text is (a hidden
// character a space, one line or kept lines, bounded), and the whole answer
// is at most MAX_BYTES: packs past it are left out, and a fixed line says
// how many. Every sentence the runtime adds is fixed (FIXED).
const {ownWords} = require('./module-settings');
const {moduleLine} = require('./module-text');

const MAX_BYTES = 8 * 1024;
const MAX_EXAMPLES = 4;
const MAX_EXAMPLE = 100;
const GUIDE = 'https://github.com/mchen6/countinghouse/blob/master/docs/module-development.md';
// a command shown for the user's own terminal: the home's launcher when
// ch-local gave one (an npx or folder install puts no ch-local on PATH)
const command = (launcher, args) => (launcher != null ? `node "${launcher}" ${args}` : `ch-local ${args}`);
const FIXED = {
  none: 'No packs are installed.',
  omitted: (n) => `${n} more ${n === 1 ? 'pack' : 'packs'} not shown.`,
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
      description: {type: 'string'},
      tools: {type: 'array', items: {type: 'string'}},
      examples: {type: 'array', items: {type: 'string'}},
      next: {type: 'string'}
    }, required: ['name', 'module', 'state', 'tools', 'examples'], additionalProperties: false}},
    omitted: {type: 'integer'},
    notice: {type: 'string'},
    scenarios: {type: 'string'}
  },
  required: ['version', 'packs', 'scenarios'],
  additionalProperties: false
};

// One pack: name (the pack, or its scenario module's name where there is no
// record), module (its scenario module's package), loaded: the caller's
// tools/list shows it, description and examples as the module gave them,
// tools (the caller's tool names), held (lib/held-back.js's entry, or null)
function packOf({name, module, loaded, description, tools, examples, held}, {settingsProfile, launcher}) {
  const out = {name, module, state: 'ready', tools: loaded ? tools.slice() : [], examples: []};
  if (loaded) {
    const words = ownWords({description: typeof(description) === 'string' ? description : undefined});
    if (words.description != null) out.description = words.description;
    for (const title of examples) {
      if (out.examples.length >= MAX_EXAMPLES) break;
      const line = typeof(title) === 'string' ? moduleLine(title, MAX_EXAMPLE) : '';
      if (line !== '') out.examples.push(line);
    }
    return out;
  }
  if (held != null && held.reason === 'off') { out.state = 'off'; return out; }
  out.state = 'not loaded';
  // a missing credential: the module's own, or the part's that blocks it
  const needs = held == null ? null : held.reason === 'credential' ? module : (held.reason === 'calls' && held.root === 'credential' ? held.via : null);
  out.next = !settingsProfile ? FIXED.notLoadedHosted : needs != null ? FIXED.credential(needs, launcher) : FIXED.notLoaded(launcher);
  return out;
}

// the text's lines before the packs, one pack's, and after them
const head = (data) => {
  const lines = [`countinghouse ${data.version}`];
  if (data.notice != null) lines.push(data.notice);
  return lines;
};
function packLines(p) {
  const lines = ['', `${p.name} (${p.state})`];
  if (p.description != null) lines.push(p.description);
  if (p.tools.length > 0) lines.push(`Tools: ${p.tools.join(', ')}`);
  if (p.examples.length > 0) lines.push(`Try: ${p.examples.map((e) => `"${e}"`).join('; ')}`);
  if (p.next != null) lines.push(p.next);
  return lines;
}
function render(data) {
  const lines = head(data);
  if (data.packs.length === 0 && !(data.omitted > 0) && data.notice == null) lines.push(FIXED.none);
  for (const p of data.packs) lines.push(...packLines(p));
  if (data.omitted > 0) lines.push('', FIXED.omitted(data.omitted));
  lines.push('', data.scenarios);
  return lines.join('\n');
}

// -> {data, text}: the structured answer and the same as text, each at most
// MAX_BYTES (packs left out from the end past it, and counted). One pass:
// each pack's bytes are added while both stay within the bound, with room
// kept for the line that counts what was left out.
const OMITTED_ROOM = 64;
function build({version, packs, settingsProfile = false, launcher = null, authoring = false, recordUnreadable = false}) {
  const shownLauncher = settingsProfile ? launcher : null;
  const all = packs.map((p) => packOf(p, {settingsProfile, launcher: shownLauncher}));
  const scenarios = authoring ? `${FIXED.scenarios} ${FIXED.authoring}` : FIXED.scenarios;
  const base = {version: String(version), packs: [], scenarios};
  if (recordUnreadable && settingsProfile) base.notice = FIXED.recordUnreadable(shownLauncher);
  const bytes = (v) => Buffer.byteLength(v, 'utf8');
  let textBytes = bytes(render(base)) + OMITTED_ROOM;
  let jsonBytes = bytes(JSON.stringify(base)) + OMITTED_ROOM;
  let kept = 0;
  for (const p of all) {
    const t = bytes(packLines(p).join('\n')) + 1;
    const j = bytes(JSON.stringify(p)) + 1;
    if (textBytes + t > MAX_BYTES || jsonBytes + j > MAX_BYTES) break;
    textBytes += t;
    jsonBytes += j;
    kept++;
  }
  const data = Object.assign({}, base, {packs: all.slice(0, kept)});
  if (kept < all.length) data.omitted = all.length - kept;
  return {data, text: render(data)};
}

module.exports = {build, OUTPUT_SCHEMA, FIXED, MAX_BYTES, MAX_EXAMPLES, MAX_EXAMPLE, GUIDE};
