// Preloaded (NODE_OPTIONS=--require) into a test's own spawned runtime only
// (test/stdio/21): a tested range for claude-code and conditions that say yes
// (no ch-local here), so a real stdio round trip runs before the hand test;
// the apply is production's (Task 5). Nothing in lib/ reads a test switch.
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const clients = require(path.join(ROOT, 'lib', 'elicitation-clients'));
const TESTED = clients.ALLOWLIST.map((e) => (e.name === clients.CLAUDE_CODE ? Object.assign({}, e, {tested: [{from: '2.0.0', before: '3.0.0'}]}) : e));
const tool = require(path.join(ROOT, 'lib', 'settings-tool'));
const create = tool.create;
tool.create = (o) => create(Object.assign({
  mayElicit: async (ctx) => { const c = clients.clientMayElicit(ctx, TESTED); return c.ok ? {ok: true, client: c.client} : c; }
}, o));
