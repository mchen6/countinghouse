'use strict';
// A module's file namespace (docs/superpowers/specs/2026-10-17-module-
// sandbox-fs-broker-design.md, section 1): /app, /data, /tmp and declared
// paths, the synthesised directories above them, and everything else
// ("outside"). prepare() resolves every root and protected path once, at
// spawn; resolve() is then pure path arithmetic, and the broker does the
// per-request host checks against the prepared real paths.
const fsp = require('fs/promises');
const path = require('path').posix;
const url = require('url');

function inside(p, root) {
  return p === root || p.startsWith(root === '/' ? '/' : `${root}/`);
}

// A path argument as a string: a Buffer decoded, a file URL made a path.
function pathString(p) {
  let s = p;
  if (Buffer.isBuffer(s)) s = s.toString('utf8');
  else if (s instanceof URL) s = url.fileURLToPath(s);
  else if (typeof(s) === 'string' && s.startsWith('file:')) s = url.fileURLToPath(s);
  if (typeof(s) !== 'string') throw new TypeError('path must be a string, Buffer or file URL');
  if (s.includes('\0')) throw Object.assign(new TypeError('path must not contain null bytes'), {code: 'ERR_INVALID_ARG_VALUE'});
  return s;
}

function toVirtualPath(p, cwd) {
  return path.resolve(cwd || '/', pathString(p));
}

const DRIVE = /^[a-zA-Z]:/;

// Under --hardened a protected path's real path comes from the parent: Node
// refuses to resolve a granted directory whose name another grant extends
// (lib/hardened-realpaths.js). Otherwise a refused or missing path is taken
// as written.
async function realOf(p) {
  const known = require('../hardened-realpaths');
  if (known.has(p)) return known.realpathSync(p);
  try { return await fsp.realpath(p); } catch (e) { return p; }
}

async function typeOf(p) {
  try { return (await fsp.stat(p)).isDirectory() ? 'dir' : 'file'; } catch (e) { return 'missing'; }
}

function createNamespace(cfg) {
  const self = {roots: [], refused: [], prepared: false};
  // Windows (issue #40): "\" is a separator there. The worker's patch gives
  // every path the "/" form but a drive-qualified, UNC or device one
  // (lib/fs-broker/roots.js virtualFormFor); what still holds a "\" is not
  // a namespace path, and a path with a drive letter is never a name under
  // the cwd. cfg.platform is for the tests; POSIX is unchanged.
  const win32 = (cfg.platform || process.platform) === 'win32';
  self.win32 = win32;
  self.platform = cfg.platform || process.platform;
  // Host paths (a root's host and real paths, the broker's realpath
  // answers) are the host's: split with path.win32 on Windows, where a real
  // path is in a root by either separator, names compared as given but the
  // drive letter's case (as lib/fs-broker/roots.js underFor); POSIX exactly
  // as before.
  self.hostPath = win32 ? require('path').win32 : path;
  const drive = (p) => (/^[a-zA-Z]:/.test(p) ? p[0].toUpperCase() + p.slice(1) : p);
  const insideHost = win32
    ? (q, r) => {
      const p = drive(q);
      const root = drive(r);
      return p === root || p.startsWith(/[\\/]$/.test(root) ? root : `${root}\\`) || p.startsWith(`${root}/`);
    }
    : inside;
  const rest = win32 ? (s) => s.replace(/\\/g, '/') : (s) => s;
  let byVroot = [];
  let byReal = [];
  let byHost = [];

  self.prepare = async function() {
    const protectedReal = [];
    for (const p of cfg.protectedPaths || []) protectedReal.push({text: p, real: await realOf(p)});
    const kept = [];
    for (const d of cfg.declared || []) {
      const real = await realOf(d.path);
      const clash = protectedReal.find((p) => insideHost(p.text, d.path) || insideHost(d.path, p.text) ||
        insideHost(p.real, real) || insideHost(real, p.real));
      // cfg.protectedLinks: the links countinghouse is reached through, each
      // by its place, its name in its parent's real path (lib/fs-broker/
      // install-links.js; #280's follow-up). A writable root that holds one
      // -- the link's directory or one above it, as declared or by its real
      // path, so by any spelling -- could repoint it. The link is protected,
      // not what it leads to: a root inside its target is none of this
      // check's, and a read-only root repoints nothing.
      const held = (clash == null && d.access === 'rw') ? (cfg.protectedLinks || []).find((l) => insideHost(l, d.path) || insideHost(l, real)) : null;
      if (clash != null) self.refused.push({path: d.path, reason: `overlaps countinghouse's ${clash.text}`});
      else if (held != null) self.refused.push({path: d.path, reason: `holds ${held}, on a path countinghouse runs through`});
      else kept.push(d);
    }
    const base = [
      {vroot: '/app', host: cfg.moduleRoot, access: 'r', writable: false, quota: false, name: 'app'},
      {vroot: '/data', host: cfg.dataDir, access: 'rw', writable: true, quota: true, name: 'data'},
      {vroot: '/tmp', host: cfg.tmpDir, access: 'rw', writable: true, quota: true, name: 'tmp'}
    ].concat(kept.map((d) => ({vroot: d.path, host: d.path, access: d.access, writable: d.access === 'rw', quota: false, name: 'declared'})));
    for (const r of base) {
      r.real = await realOf(r.host);
      r.type = await typeOf(r.host);
    }
    self.roots = base;
    byVroot = base.slice().sort((a, b) => b.vroot.length - a.vroot.length);
    byReal = base.slice().sort((a, b) => b.real.length - a.real.length);
    byHost = base.slice().sort((a, b) => b.host.length - a.host.length);
    self.prepared = true;
  };

  self.resolve = function(p, cwd) {
    if (!self.prepared) throw new Error('namespace used before prepare()');
    const s = pathString(p);
    if (win32 && DRIVE.test(s)) return {kind: 'outside', virtual: s, host: s};
    const v = path.resolve(cwd || '/', s);
    const root = byVroot.find((r) => inside(v, r.vroot));
    // Windows: a namespace path holding a "\" is refused (the broker's place).
    if (win32 && v.includes('\\') && (root != null || byVroot.some((r) => inside(r.vroot, v)))) return {kind: 'refused', virtual: v};
    // the host path in the host's separators (on Windows a mixed C:\d/x
    // failed the "root\" prefix checks of anything that did not realpath it)
    if (root != null) return {kind: 'root', virtual: v, host: root.host + (win32 ? v.slice(root.vroot.length).replace(/\//g, '\\') : v.slice(root.vroot.length)), root: root};
    const below = byVroot.filter((r) => inside(r.vroot, v) && r.vroot !== v);
    if (below.length > 0) {
      const seen = new Map();
      below.forEach((r) => {
        const rest = r.vroot.slice(v === '/' ? 1 : v.length + 1).split('/');
        const name = rest[0];
        const type = (rest.length === 1 && r.type === 'file') ? 'file' : 'dir';
        if (!seen.has(name) || type === 'dir') seen.set(name, type);
      });
      const children = Array.from(seen.keys()).sort().map((name) => ({name: name, type: seen.get(name)}));
      return {kind: 'ancestor', virtual: v, children: children};
    }
    return {kind: 'outside', virtual: v, host: v};
  };

  self.rootForReal = function(realPath) {
    return byReal.find((r) => insideHost(realPath, r.real)) || null;
  };

  self.toVirtual = function(given) {
    // Windows hands some results back in the long-path form, \\?\D:\...
    // (a recursive mkdir's first directory): the same path.
    const hostPath = (win32 && typeof(given) === 'string' && given.startsWith('\\\\?\\') && DRIVE.test(given.slice(4))) ? given.slice(4) : given;
    const viaReal = byReal.find((r) => insideHost(hostPath, r.real));
    if (viaReal != null) return viaReal.vroot + rest(hostPath.slice(viaReal.real.length));
    const viaHost = byHost.find((r) => insideHost(hostPath, r.host));
    return viaHost == null ? null : viaHost.vroot + rest(hostPath.slice(viaHost.host.length));
  };

  return self;
}

module.exports = {createNamespace, toVirtualPath, inside};
