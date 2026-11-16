'use strict';
// A result's binary values, placed (MCP completeness M6, spec sections 1
// and 2). Three steps, so a task can store once at completion and rebuild
// its answer from the URIs it kept:
//   plan(output, schema, who, {inlineBytes})   sync, deterministic
//     -> null when the schema declares no binary field, else the values in
//     schema order, each {pointer, mediaType, value, bytes, kind, inline,
//     store, name, description}. The budget is --inlineContentBytes of
//     decoded bytes per result: each value that fits what is left is
//     inlined, the rest are linked. kind: image, audio or resource (any
//     other media type). A resource value is stored even when inline (its
//     block carries a uri), and a linked one always.
//   store(entries, {blobs, owner, source})      async
//     -> {pointer: uri} for each entry with store set. A put that fails
//     (RESULT_STORE_FULL past a limit) removes the values this call stored
//     already, then the error goes on: nothing is half stored.
//   assemble(output, entries, uris)             sync
//     -> {structured, blocks}: each value replaced in structured by the
//     reference {mimeType, bytes, block?, uri?}, the blocks in schema order:
//     an inline image/audio block, an inline {type: resource, resource: {uri,
//     mimeType, blob}}, or {type: resource_link, uri, name, description,
//     mimeType, size}. A value whose uri is missing (no owner to store it
//     for, or a task whose stored value is gone) is linked to nothing: it
//     stays inline if it is an image or audio, and is otherwise its base64
//     as before M6.
// The owner is the outer call's opaque caller id (u_...), never a key: a
// composite's parts never come through here, so a part's identity owns
// nothing. Session scope (the shared runtime) is M17's: null here.
const binaryFieldsLib = require('../binary-fields');

const URI_PREFIX = 'countinghouse://r/';
const uriOf = (id) => `${URI_PREFIX}${id}`;
const idOfUri = (uri) => (typeof(uri) === 'string' && uri.startsWith(URI_PREFIX) ? uri.slice(URI_PREFIX.length) : null);

const kindOf = (mediaType) => (/^image\//.test(mediaType) ? 'image' : (/^audio\//.test(mediaType) ? 'audio' : 'resource'));

// the field's own schema, along its path (properties and items only, as the
// map walks)
function fieldSchemaAt(schema, path) {
  let s = schema;
  for (const step of path) {
    if (s == null || typeof(s) !== 'object') return null;
    s = (step === '*') ? s.items : (s.properties != null ? s.properties[step] : null);
  }
  return (s != null && typeof(s) === 'object') ? s : null;
}

function plan(output, schema, who = {}, {inlineBytes = 1024 * 1024} = {}) {
  const fields = binaryFieldsLib.blockFields(schema);
  if (fields.length === 0) return null;
  const entries = [];
  for (const f of fields) {
    const fs = fieldSchemaAt(schema, f.path);
    const named = f.path.filter((step) => step !== '*');
    const name = named.length > 0 ? named[named.length - 1] : String(who.tool || who.action || 'output');
    const description = (fs != null && typeof(fs.description) === 'string') ? fs.description : null;
    for (const v of binaryFieldsLib.binaryValues([f], output, who)) entries.push({...v, name, description});
  }
  // every value counts toward the one cap, as binaryValues counts them
  if (entries.length > binaryFieldsLib.MAX_BINARY_VALUES) binaryFieldsLib.binaryValues(fields, output, who);
  let left = Number.isInteger(inlineBytes) && inlineBytes > 0 ? inlineBytes : 0;
  for (const e of entries) {
    e.bytes = binaryFieldsLib.decodedLength(e.value);
    e.kind = kindOf(e.mediaType);
    e.inline = e.bytes <= left;
    if (e.inline) left -= e.bytes;
    e.store = e.kind === 'resource' || !e.inline;
  }
  return entries;
}

async function store(entries, {blobs, owner, source = {}}) {
  const uris = {};
  if (entries == null || blobs == null || owner == null) return uris;
  const stored = [];
  try {
    for (const e of entries) {
      if (!e.store) continue;
      const {id} = await blobs.put({owner, session: null, mimeType: e.mediaType, bytes: Buffer.from(e.value, 'base64'),
        source: {module: source.module != null ? String(source.module) : null, tool: source.tool != null ? String(source.tool) : null, field: e.pointer}});
      stored.push(id);
      uris[e.pointer] = uriOf(id);
    }
  } catch (err) {
    await Promise.allSettled(stored.map((id) => blobs.remove(id)));
    throw err;
  }
  return uris;
}

function assemble(output, entries, uris = {}) {
  let structured = output;
  const blocks = [];
  for (const e of entries) {
    const uri = Object.hasOwn(uris, e.pointer) ? uris[e.pointer] : null;
    let reference;
    if (uri != null && !e.inline) {
      blocks.push({type: 'resource_link', uri, name: e.name, ...(e.description != null ? {description: e.description} : {}), mimeType: e.mediaType, size: e.bytes});
      reference = {mimeType: e.mediaType, bytes: e.bytes, uri};
    } else if (e.kind !== 'resource') {
      blocks.push({type: e.kind, data: e.value, mimeType: e.mediaType});
      reference = {mimeType: e.mediaType, bytes: e.bytes, block: blocks.length, ...(uri != null ? {uri} : {})};
    } else if (uri != null) {
      blocks.push({type: 'resource', resource: {uri, mimeType: e.mediaType, blob: e.value}});
      reference = {mimeType: e.mediaType, bytes: e.bytes, block: blocks.length, uri};
    } else {
      continue;   // nowhere to store it: its base64 stays, as before M6
    }
    structured = binaryFieldsLib.replaceAt(structured, e.pointer, reference);
  }
  return {structured, blocks};
}

module.exports = {plan, store, assemble, uriOf, idOfUri, URI_PREFIX};
