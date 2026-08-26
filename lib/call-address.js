// A composition address: <friendlyName>/<serviceLabel>.<actionName>
//
//   repo-scan/scanService.scan
//
// Deliberately NOT the MCP tool name (repo_scan_scan). Tool names are
// deduped with a _2 suffix on collision, in an order that depends on module
// load order (lib/mcp/tool-registry.js), slugify is lossy, and actions
// without a description are dropped from tools/list entirely -- none of
// which a hardcoded address can survive.
//
// This file has no requires beyond uuid-1345 so the serverless validator and
// its tests can load it without opening a Redis socket, the same reason
// lib/mcp/tool-name.js exists alone.
const UUID = require('uuid-1345');

const ADDRESS_FORM = '<module>/<service>.<action>';

// 'apemesh' in the seed is a deliberately kept hash seed, not a missed
// rename: changing it reassigns every existing device's UUID. This is the
// single definition -- lib/countinghouse-device.js calls it rather than
// repeating the template, because a drifted copy would make every address
// resolve to a device that does not exist.
function deviceIDForName(friendlyName) {
  return UUID.v5({
    namespace: UUID.namespace.url,
    name: `https://registry.apemesh.com/packages/${friendlyName}`
  });
}

// Exactly one '/' and one '.', and no part may contain either. Returns null
// rather than guessing: an address with two dots has no correct reading, and
// picking one would resolve silently to the wrong tool.
function parseAddress(address) {
  if (typeof address !== 'string') return null;

  const slash = address.split('/');
  if (slash.length !== 2) return null;

  const device = slash[0];
  const dot    = slash[1].split('.');
  if (dot.length !== 2) return null;

  const service = dot[0];
  const action  = dot[1];

  if (device === '' || service === '' || action === '') return null;
  if (device.indexOf('.') !== -1) return null;

  return {device: device, service: service, action: action};
}

// The service half cannot be resolved by string rules: the URN's vendor
// segment varies across modules (urn:countinghouse-com:, urn:example-com:),
// so the target's own spec is the only authority.
function resolveAddress(spec, parsed) {
  if (parsed == null) {
    return {ok: false, message: `not a valid address -- expected ${ADDRESS_FORM}`};
  }

  const serviceList = (spec != null && spec.device != null) ? spec.device.serviceList : null;
  if (serviceList == null) {
    return {ok: false, message: `module "${parsed.device}" declares no services`};
  }

  const matches = [];
  const known   = [];
  for (const urn in serviceList) {
    const label = urn.split(':').pop();
    known.push(label);
    if (label === parsed.service) matches.push(urn);
  }

  if (matches.length === 0) {
    return {ok: false, message: `module "${parsed.device}" has no service "${parsed.service
                                }" -- it declares: ${known.join(', ')}`};
  }
  if (matches.length > 1) {
    return {ok: false, message: `service label "${parsed.service}" is ambiguous on module "${
                                parsed.device}" -- it matches ${matches.join(' and ')
                                }. Rename one of them.`};
  }

  const serviceID  = matches[0];
  const actionList = serviceList[serviceID].actionList;
  const actions    = Array.isArray(actionList) ? actionList.map((a) => a.name) : [];

  if (actions.indexOf(parsed.action) === -1) {
    return {ok: false, message: `service "${parsed.service}" on module "${parsed.device
                                }" has no action "${parsed.action}" -- it declares: ${
                                actions.join(', ')}`};
  }

  return {ok: true, serviceID: serviceID};
}

module.exports = {
  ADDRESS_FORM:    ADDRESS_FORM,
  deviceIDForName: deviceIDForName,
  parseAddress:    parseAddress,
  resolveAddress:  resolveAddress
};
