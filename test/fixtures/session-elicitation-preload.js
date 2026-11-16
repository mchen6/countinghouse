// Preloaded (NODE_OPTIONS=--require) into a test's own spawned shared runtime
// only (test/session-runtime/01): a tested range for claude-code, so a
// session's form runs over the real listener and shim before the hand test.
// The conditions are the session's own shim's answers (the test's), and the
// rest is production's. Nothing in lib/ reads a test switch.
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const clients = require(path.join(ROOT, 'lib', 'elicitation-clients'));
const TESTED = clients.ALLOWLIST.map((e) => (e.name === clients.CLAUDE_CODE ? Object.assign({}, e, {tested: [{from: '2.0.0', before: '3.0.0'}]}) : e));
const tool = require(path.join(ROOT, 'lib', 'settings-tool'));
const create = tool.create;
tool.create = (o) => create(Object.assign({allowlist: TESTED}, o));
