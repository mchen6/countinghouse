// The one rule for turning a device/service/action name into an MCP tool
// name. It lives alone, with no requires, so anything that needs to predict a
// tool name can have it without dragging in tool-registry.js -- which opens a
// Redis socket at require time and would keep a test process alive.
function slugify(s) {
  const out = String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return out === '' ? 'x' : out;
}

// The service part of a tool name: the last segment of its serviceID URN.
function serviceLabel(urn) {
  const parts = String(urn).split(':');
  return slugify(parts[parts.length - 1]);
}

// The name a module's action is listed under: a scenario's under its bare
// action name, every other module's as <device>_<service>_<action>
// (reviewer, 2026-11-11). lib/mcp/tool-registry.js lists by it and
// lib/module-roles.js checks names at load by it, so the two always agree.
function toolNameFor(role, deviceName, serviceURN, actionName) {
  return role === 'scenario' ? slugify(actionName) : `${slugify(deviceName)}_${serviceLabel(serviceURN)}_${slugify(actionName)}`;
}

// Every runtime built-in tool name (lib/mcp/tool-registry.js PLATFORM_TOOL_NAMES
// and AUTHORING_TOOL_NAMES; a test keeps the two in step). A scenario's bare
// tool name may not be one of them (lib/module-roles.js).
const RESERVED_TOOL_NAMES = [
  'countinghouse_check_balance',
  'countinghouse_validate_plan',
  'countinghouse_validate_module',
  'countinghouse_load_module',
  'countinghouse_call_tool',
  'countinghouse_reload_auth',
  'countinghouse_lookup_identity'
];

module.exports = {
  slugify: slugify,
  serviceLabel: serviceLabel,
  toolNameFor: toolNameFor,
  RESERVED_TOOL_NAMES: RESERVED_TOOL_NAMES
};
