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
  let byVroot = [];
  let byReal = [];
  let byHost = [];

  self.prepare = async function() {
    const protectedReal = [];
    for (const p of cfg.protectedPaths || []) protectedReal.push({text: p, real: await realOf(p)});
    const kept = [];
    for (const d of cfg.declared || []) {
      const real = await realOf(d.path);
      const clash = protectedReal.find((p) => inside(p.text, d.path) || inside(d.path, p.text) ||
        inside(p.real, real) || inside(real, p.real));
      if (clash != null) self.refused.push({path: d.path, reason: `overlaps countinghouse's ${clash.text}`});
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
    if (root != null) return {kind: 'root', virtual: v, host: root.host + v.slice(root.vroot.length), root: root};
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
    return byReal.find((r) => inside(realPath, r.real)) || null;
  };

  self.toVirtual = function(hostPath) {
    const viaReal = byReal.find((r) => inside(hostPath, r.real));
    if (viaReal != null) return viaReal.vroot + hostPath.slice(viaReal.real.length);
    const viaHost = byHost.find((r) => inside(hostPath, r.host));
    return viaHost == null ? null : viaHost.vroot + hostPath.slice(viaHost.host.length);
  };

  return self;
}

module.exports = {createNamespace, toVirtualPath, inside};
