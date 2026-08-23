// The one rule for turning a device/service/action name into an MCP tool
// name. It lives alone, with no requires, so anything that needs to predict a
// tool name can have it without dragging in tool-registry.js -- which opens a
// Redis socket at require time and would keep a test process alive.
function slugify(s) {
  const out = String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return out === '' ? 'x' : out;
}

module.exports = {
  slugify: slugify
};
