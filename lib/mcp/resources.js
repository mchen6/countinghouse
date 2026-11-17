'use strict';
// Module resources (MCP completeness M7, spec section 3): the registry
// behind resources/list, resources/templates/list and a module resource's
// resources/read. A resource is an action that declares `resource:
// {uriTemplate, name, title?, mimeType?, icons?, changesWith?}`; it is read
// by running that action, through the same runner as a tools/call
// (lib/mcp/gateway.js runModuleTarget), and is not also a tool
// (tool-registry buildToolTargets skips it).
//
// The URI is countinghouse://m/<module>/<path> (lib/mcp/resource-uri.js, the
// one strict parser). <module> is the module's slug as tool names use it,
// deduped over every listed module before a caller's grants filter them, so
// a URI never depends on the key. A caller's resources are found as its
// tools are: the listed modules (an unlisted part's never; the single-
// identity profile's scenarios only) on the devices it is granted. A URI
// outside them is no more than an unknown one.
const toolRegistry = require('./tool-registry');
const {slugify, toolNameFor} = require('./tool-name');
const resourceUri = require('./resource-uri');
const {isBinary} = require('../binary-fields');

const isObject = (v) => v != null && typeof(v) === 'object' && !Array.isArray(v);

// A declaration's compiled template, kept per declaration object with the
// template it was compiled from: no request recompiles it, and a template
// changed in place (a device's updateDeviceSpec mutates its spec, bumping
// only the generation) is compiled again, so a read never matches the old
// template while the list shows the new one (the review of #327).
const compiledOf = new WeakMap();
function compiledFor(resource) {
  const kept = compiledOf.get(resource);
  if (kept != null && kept.template === resource.uriTemplate) return kept.compiled;
  const compiled = resourceUri.compile(resource.uriTemplate);
  compiledOf.set(resource, {template: resource.uriTemplate, compiled});
  return compiled;
}

// Two listed modules whose names slug alike serve no resource (fail closed),
// and the operator is told once per slug for the process's life, never on
// every list (the review of #327).
const warnedSlugs = new Set();
function warnCollision(slug) {
  if (warnedSlugs.has(slug)) return;
  warnedSlugs.add(slug);
  try {
    require('../logger').W(`module resources: two listed modules have the slug "${slug}" in their resource URIs (countinghouse://m/${slug}/...), so neither's resources are served; rename one of them`);
  } catch (e) { /* no logger */ }
}

// -> callback(err, [entry]): the caller's resources, in spec order. An
// entry: {slug, uriTemplate (full), compiled, resource, target}, where
// target is the action as the runner takes it (a tool target's shape:
// name, deviceID, serviceID, actionName, description, action, role,
// module).
// A module's slug is its name as tool names spell it. Two listed modules
// whose names slug alike serve no resource at all: a suffix by load order
// would let a stored URI come to name the other module's resource after an
// unload or a restart (the review of M7). Decided over every listed module,
// before a caller's grants, so a URI never depends on the key.
function listEntries(cdifInterface, appKey, callback) {
  toolRegistry.grantedDevices(appKey, (err, granted) => {
    if (err) return callback(err);
    const dm = cdifInterface.deviceManager;
    const specs = dm.getAllDeviceSpecs();
    const found = [];
    const slugCount = new Map();
    for (const deviceID of Object.keys(specs)) {
      const listing = toolRegistry.listingOf(cdifInterface, deviceID);
      if (!listing.listed) continue;
      const spec = specs[deviceID];
      const serviceList = (spec != null && spec.device != null) ? spec.device.serviceList : null;
      if (!isObject(serviceList)) continue;
      const module = spec.device.friendlyName || deviceID;
      const slug = slugify(module);
      let any = false;
      for (const serviceID of Object.keys(serviceList)) {
        const actions = isObject(serviceList[serviceID]) && Array.isArray(serviceList[serviceID].actionList) ? serviceList[serviceID].actionList : [];
        for (const action of actions) {
          if (!isObject(action) || !isObject(action.resource) || typeof(action.name) !== 'string') continue;
          const compiled = compiledFor(action.resource);
          if (compiled == null) continue;
          any = true;
          found.push({deviceID, slug, compiled, resource: action.resource,
            target: {name: toolNameFor(listing.role, module, serviceID, action.name), deviceID, serviceID, actionName: action.name,
              description: action.description, action, role: listing.role, module}});
        }
      }
      if (any) slugCount.set(slug, (slugCount.get(slug) || 0) + 1);
    }
    for (const [slug, count] of slugCount) if (count > 1) warnCollision(slug);
    const out = found.filter((e) => slugCount.get(e.slug) === 1 && (granted == null || granted.has(e.deviceID)))
      .map((e) => ({slug: e.slug, uriTemplate: resourceUri.full(e.slug, e.resource.uriTemplate), compiled: e.compiled, resource: e.resource, target: e.target}));
    return callback(null, out);
  });
}

// What a list shows of one: resources/list's {uri, ...} for a template with
// no variable, resources/templates/list's {uriTemplate, ...} for the rest;
// name, title, description (the action's when absent), mimeType and icons
// as declared (icons from what the load kept, M2).
function describe(cdifInterface, entry) {
  const r = entry.resource;
  const out = entry.compiled.variables.length === 0 ? {uri: entry.uriTemplate} : {uriTemplate: entry.uriTemplate};
  if (typeof(r.name) === 'string') out.name = r.name;
  if (typeof(r.title) === 'string') out.title = r.title;
  const description = typeof(r.description) === 'string' ? r.description : entry.target.description;
  if (typeof(description) === 'string') out.description = description;
  if (typeof(r.mimeType) === 'string') out.mimeType = r.mimeType;
  const icons = toolRegistry.inlineIcons(r.icons, toolRegistry.keptIcons(cdifInterface, entry.target.deviceID));
  if (icons != null) out.icons = icons;
  return out;
}
const isStatic = (entry) => entry.compiled.variables.length === 0;

// A URI among the caller's entries -> {entry, input}, or null: parsed
// strictly (lib/mcp/resource-uri.js), its variables the action's input
function find(entries, uri) {
  const parts = resourceUri.split(uri);
  if (parts == null) return null;
  for (const entry of entries) {
    if (entry.slug !== parts.slug) continue;
    const vars = resourceUri.match(entry.compiled, parts.segments);
    if (vars != null) return {entry, input: vars};
  }
  return null;
}

// The read's one `contents` entry, under the URI that was asked for: a
// string output as text, with the output schema's contentMediaType, else the
// declared mimeType, else text/plain; a binary string output (section 1's
// declaration) as a blob with its media type; anything else as its JSON.
function contentsOf(entry, uri, output, rawSchema) {
  if (typeof(output) === 'string') {
    if (isBinary(rawSchema)) return {uri, mimeType: rawSchema.contentMediaType, blob: output};
    const mimeType = (isObject(rawSchema) && typeof(rawSchema.contentMediaType) === 'string') ? rawSchema.contentMediaType
      : (typeof(entry.resource.mimeType) === 'string' ? entry.resource.mimeType : 'text/plain');
    return {uri, mimeType, text: output};
  }
  return {uri, mimeType: 'application/json', text: JSON.stringify(output === undefined ? null : output)};
}

module.exports = {listEntries, describe, isStatic, find, contentsOf};
