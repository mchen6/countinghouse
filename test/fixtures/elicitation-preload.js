// Preloaded (NODE_OPTIONS=--require) into a test's own spawned runtime only
// (test/stdio/21): sets a tested floor for claude-code and gives the settings
// tool conditions that say yes and an apply that sets the option, so a real
// stdio round trip can be tested before the hand test and Tasks 4-5. Nothing
// in lib/ reads a test switch.
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const clients = require(path.join(ROOT, 'lib', 'elicitation-clients'));
const TESTED = clients.ALLOWLIST.map((e) => (e.name === clients.CLAUDE_CODE ? Object.assign({}, e, {tested: [{from: '2.0.0', before: '3.0.0'}]}) : e));
const options = require(path.join(ROOT, 'lib', 'cli-options'));
const tool = require(path.join(ROOT, 'lib', 'settings-tool'));
const create = tool.create;
tool.create = (o) => create(Object.assign({
  mayElicit: async (ctx) => { const c = clients.clientMayElicit(ctx, TESTED); return c.ok ? {ok: true, client: c.client} : c; },
  applyChange: async (staged) => { options[staged.name] = staged.next; }
}, o));
