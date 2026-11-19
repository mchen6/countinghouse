'use strict';
// The icon files a module declares (the MCP completeness design, section 4):
// `icons: [{file, sizes?}]` on an action, on its resource and on a prompt.
// An icon is a file inside the module, a PNG, JPEG or WebP of at most
// 16 KiB, sent inline: never a URL, since a client that fetched one would
// tell the module's author the user's address. SVG is refused: it can carry
// script.
//
//   read(moduleRoot, file) -> {mimeType, bytes} | {problem: text}
//   problems(moduleRoot, spec) -> [{path, message}]
//   inline(moduleRoot, spec) -> {icons: Map(file -> {mimeType, data, src})} | {problem: text}
//
// countinghouse-validate reports problems() (lib/module-validator.js). The
// load reads each icon with this same read() when it inlines them (M2), and
// is the one that decides.
//
// What a file is comes from its first bytes, never its name. A path is
// taken only as the meta-schema writes one (forward slashes, no leading
// slash, no .. segment, no scheme), and the file it names, followed through
// any symlink, must be inside the module.
//
// What is opened is what was checked: the resolved path is opened without
// following a link in its last place and without waiting on a FIFO, the
// open file is the one the path named a moment before (the same device and
// inode), and the name still resolves to it afterwards. What remains is a
// directory above the file swapped for a link and swapped back between two
// of those steps, by something that can write the module's own files.
const fs = require('fs');
const declarations = require('./declarations');

const MAX_ICON_BYTES = 16 * 1024;
// read by one problems() call: the meta-schema lets an action, a resource
// and a prompt four each, and a spec is checked here before it is checked
// against the meta-schema
const MAX_ICONS_CHECKED = 256;
// a path as the meta-schema writes one: its own pattern and length
const FILE_SCHEMA = require('../spec/schema.json').$defs.icons.items.properties.file;
const FILE = new RegExp(FILE_SCHEMA.pattern);
const MAX_FILE_LENGTH = FILE_SCHEMA.maxLength;
// never through a link in the last place, never waiting on a FIFO (neither
// flag exists on Windows)
const OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);

const isObject = (v) => v != null && typeof(v) === 'object' && !Array.isArray(v);
// (taken at load, not on first use: a validation worker loads this file
// at boot, and nothing of the runtime's after its lockdown, #194's PR 1)
const schemaSafety = require('./schema-safety');
const identity = require('./fs-broker/identity');
const shown = (text) => schemaSafety.declaredText(text);

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function typeOf(bytes) {
  if (bytes.length >= PNG.length && bytes.subarray(0, PNG.length).equals(PNG)) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}
// by its name, or by how it begins
const looksLikeSvg = (file, bytes) => /\.svgz?$/i.test(file) || /^(?:﻿)?\s*<(?:\?xml|!DOCTYPE\s+svg|svg)[\s>/]/i.test(bytes.toString('utf8', 0, 256));

// -> {mimeType, bytes}, or {problem} (a text that follows the file's name)
function read(moduleRoot, file) {
  if (typeof(file) !== 'string' || file.length > MAX_FILE_LENGTH || !FILE.test(file)) {
    return {problem: 'is not a path inside the module (forward slashes, no leading /, no .. segment, no scheme)'};
  }
  // a module worker validates /app, POSIX on every OS (identity.pathFor)
  const P = identity.pathFor(moduleRoot);
  let root;
  let real;
  try {
    root = fs.realpathSync.native(P.resolve(String(moduleRoot)));
  } catch (e) {
    return {problem: 'could not be read: the module\'s directory is not there'};
  }
  try {
    real = fs.realpathSync.native(P.join(root, ...file.split('/')));
  } catch (e) {
    return {problem: 'does not exist'};
  }
  // where it leads is not said: it is no path of the module's
  if (!(real.length > root.length && real.startsWith(root) && (root.endsWith(P.sep) || real[root.length] === P.sep))) return {problem: 'is outside the module (a symlink that leaves it)'};
  let fd = null;
  try {
    // the resolved path has no link in it now: what is there is the file
    // (as bigints: an inode number past 2^53, as a Windows file index can be,
    // loses its low bits as a Number, and two files would compare alike)
    const named = fs.lstatSync(real, {bigint: true});
    if (!named.isFile()) return {problem: 'is not a file'};
    fd = fs.openSync(real, OPEN_FLAGS);
    const st = fs.fstatSync(fd, {bigint: true});
    if (!st.isFile()) return {problem: 'is not a file'};
    if (st.ino !== named.ino || st.dev !== named.dev) return {problem: 'changed while it was read'};
    const size = Number(st.size);
    if (size > MAX_ICON_BYTES) return {problem: `is ${size} bytes; an icon is at most ${MAX_ICON_BYTES}`};
    // one byte more than the bound: a file that grew since is seen
    const buffer = Buffer.alloc(MAX_ICON_BYTES + 1);
    let length = 0;
    for (;;) {
      const got = fs.readSync(fd, buffer, length, buffer.length - length, length);
      if (got <= 0) break;
      length += got;
      if (length === buffer.length) break;
    }
    if (length > MAX_ICON_BYTES) return {problem: `is over ${MAX_ICON_BYTES} bytes; an icon is at most ${MAX_ICON_BYTES}`};
    const bytes = Buffer.from(buffer.subarray(0, length));
    // and its name still leads to the file that was read
    let still = null;
    try { still = fs.realpathSync.native(P.join(root, ...file.split('/'))); } catch (e) { still = null; }
    if (still !== real) return {problem: 'changed while it was read'};
    if (looksLikeSvg(file, bytes)) return {problem: 'SVG is refused: it can carry script; give a PNG, JPEG or WebP'};
    const mimeType = typeOf(bytes);
    if (mimeType == null) return {problem: 'is not a PNG, JPEG or WebP (by its first bytes)'};
    return {mimeType: mimeType, bytes: bytes};
  } catch (e) {
    return {problem: `could not be read (${String(e != null && e.code != null ? e.code : 'error').slice(0, 32)})`};
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch (e) { /* closed */ } }
  }
}

// every icons list a spec declares: [{where, list}]
function listsOf(spec) {
  const out = [];
  for (const {name, action} of declarations.actionsOf(spec)) {
    if (Array.isArray(action.icons)) out.push({where: `${name} icons`, list: action.icons});
    if (isObject(action.resource) && Array.isArray(action.resource.icons)) out.push({where: `${name} resource icons`, list: action.resource.icons});
  }
  const device = isObject(spec) && isObject(spec.device) ? spec.device : {};
  for (const prompt of Array.isArray(device.promptList) ? device.promptList : []) {
    if (isObject(prompt) && typeof(prompt.name) === 'string' && Array.isArray(prompt.icons)) out.push({where: `prompt ${prompt.name} icons`, list: prompt.icons});
  }
  return out;
}

// -> [{path, message}], for countinghouse-validate. A file named more than
// once is read once.
function problems(moduleRoot, spec) {
  const out = [];
  const seen = new Map();   // file -> its problem, or null
  let checked = 0;
  for (const {where, list} of listsOf(spec)) {
    for (const icon of list) {
      if (!isObject(icon)) continue;   // the meta-schema's own error
      if (checked >= MAX_ICONS_CHECKED) {
        out.push({path: shown(where), message: `more than ${MAX_ICONS_CHECKED} icons are declared; the rest are not checked`});
        return out;
      }
      checked += 1;
      const key = typeof(icon.file) === 'string' ? icon.file : null;
      let problem;
      if (key != null && seen.has(key)) {
        problem = seen.get(key);
      } else {
        const got = read(moduleRoot, icon.file);
        problem = got.problem != null ? got.problem : null;
        if (key != null) seen.set(key, problem);
      }
      // cut and cleaned as every message of the checks is (declarations.check)
      if (problem != null) out.push({path: shown(where), message: shown(`${where}: ${JSON.stringify(String(icon.file).slice(0, 80))} ${problem}`)});
    }
  }
  return out;
}

// The load's read (M2): every icon the spec declares, each file once, kept
// as {mimeType, data (base64)} for tools/list to inline -- the list never
// reads a file. -> {icons: Map(file -> {mimeType, data})}, or {problem}: the
// first problem, in countinghouse-validate's words, which refuses the load.
function inline(moduleRoot, spec) {
  const kept = new Map();
  let checked = 0;
  for (const {where, list} of listsOf(spec)) {
    for (const icon of list) {
      if (!isObject(icon)) return {problem: shown(`${where}: an icon is not an object`)};
      // one file named by many entries is read once, and counted once
      if (typeof(icon.file) === 'string' && kept.has(icon.file)) continue;
      if (checked >= MAX_ICONS_CHECKED) return {problem: shown(`${where}: more than ${MAX_ICONS_CHECKED} icon files are declared`)};
      checked += 1;
      const got = read(moduleRoot, icon.file);
      if (got.problem != null) return {problem: shown(`${where}: ${JSON.stringify(String(icon.file).slice(0, 80))} ${got.problem}`)};
      const data = got.bytes.toString('base64');
      // the data: URI tools/list sends, built once here
      kept.set(icon.file, {mimeType: got.mimeType, data: data, src: `data:${got.mimeType};base64,${data}`});
    }
  }
  return {icons: kept};
}

module.exports = {read, problems, inline, listsOf, FILE, MAX_ICON_BYTES, MAX_ICONS_CHECKED};
