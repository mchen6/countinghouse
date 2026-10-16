// A module's permission declaration (package.json "countinghouse.permissions")
// and how the operator's policy narrows it. Pure functions: no I/O, so the
// rules are tested directly (test/sandbox/02-permissions.js). The design is
// docs/superpowers/specs/2026-10-15-module-sandbox-foundation-design.md,
// section 2.
const path = require('path');

const DEFAULT_LIMITS = Object.freeze({heapMb: 256, externalMb: 256, maxBlockMs: 10000});
const LIMIT_KEYS     = Object.keys(DEFAULT_LIMITS);
// Part 2's virtual root owns these; a declaration may not name them.
const RESERVED       = ['/app', '/data', '/tmp'];
const ENV_NAME       = /^[A-Z_][A-Z0-9_]*$/;
const LABEL          = '[a-z0-9]([a-z0-9-]*[a-z0-9])?';
const HOST           = new RegExp(`^(\\*\\.)?${LABEL}(\\.${LABEL})*$`);
const ACCESS_RANK    = {r: 1, rw: 2};

function isReserved(p) {
  return p === '/' || RESERVED.some((r) => p === r || p.startsWith(`${r}/`));
}

function parseFs(list, problems) {
  if (list == null) return [];
  if (!Array.isArray(list)) { problems.push('countinghouse.permissions.fs must be an array'); return []; }
  const out = [];
  list.forEach((e, i) => {
    const where = `countinghouse.permissions.fs[${i}]`;
    if (e == null || typeof(e.path) !== 'string') return problems.push(`${where}.path must be a string`);
    const p = e.path;
    if (!path.posix.isAbsolute(p)) return problems.push(`${where}.path "${p}" must be absolute`);
    if (p.split('/').indexOf('..') !== -1 || path.posix.normalize(p) !== p || (p.length > 1 && p.endsWith('/'))) {
      return problems.push(`${where}.path "${p}" must be normalized (no "..", no trailing "/")`);
    }
    if (isReserved(p)) return problems.push(`${where}.path "${p}" is reserved: "/" and /app, /data, /tmp belong to the module's own root`);
    if (!Object.prototype.hasOwnProperty.call(ACCESS_RANK, e.access)) return problems.push(`${where}.access must be "r" or "rw"`);
    out.push({path: p, access: e.access});
  });
  return out;
}

function parseNet(list, problems) {
  if (list == null) return [];
  if (!Array.isArray(list)) { problems.push('countinghouse.permissions.net must be an array'); return []; }
  const out = [];
  list.forEach((e, i) => {
    const where = `countinghouse.permissions.net[${i}]`;
    if (e == null || typeof(e.host) !== 'string' || !HOST.test(e.host.toLowerCase())) {
      return problems.push(`${where}.host must be a hostname, optionally starting with "*."`);
    }
    let ports = null;
    if (e.ports != null) {
      if (!Array.isArray(e.ports) || !e.ports.every((p) => Number.isInteger(p) && p >= 1 && p <= 65535)) {
        return problems.push(`${where}.ports must be an array of integers 1-65535`);
      }
      ports = e.ports.slice();
    }
    out.push({host: e.host.toLowerCase(), ports: ports});
  });
  return out;
}

function parseEnv(list, problems) {
  if (list == null) return [];
  if (!Array.isArray(list)) { problems.push('countinghouse.permissions.env must be an array'); return []; }
  return list.filter((name, i) => {
    if (typeof(name) === 'string' && ENV_NAME.test(name)) return true;
    problems.push(`countinghouse.permissions.env[${i}] "${name}" is not a valid environment variable name`);
    return false;
  });
}

function parseLimits(obj, problems) {
  if (obj == null) return {};
  if (typeof(obj) !== 'object' || Array.isArray(obj)) { problems.push('countinghouse.permissions.limits must be an object'); return {}; }
  const out = {};
  Object.keys(obj).forEach((k) => {
    if (LIMIT_KEYS.indexOf(k) === -1) return problems.push(`countinghouse.permissions.limits.${k} is not a known limit (${LIMIT_KEYS.join(', ')})`);
    if (!Number.isInteger(obj[k]) || obj[k] <= 0) return problems.push(`countinghouse.permissions.limits.${k} must be a positive integer`);
    out[k] = obj[k];
  });
  return out;
}

function parseDeclaration(pkg) {
  const problems = [];
  const raw = (pkg != null && pkg.countinghouse != null) ? pkg.countinghouse.permissions : null;
  if (raw == null) return {declared: {fs: [], net: [], env: [], limits: {}}, problems: problems};
  if (typeof(raw) !== 'object' || Array.isArray(raw)) {
    return {declared: {fs: [], net: [], env: [], limits: {}}, problems: ['countinghouse.permissions must be an object']};
  }
  return {
    declared: {
      fs:     parseFs(raw.fs, problems),
      net:    parseNet(raw.net, problems),
      env:    parseEnv(raw.env, problems),
      limits: parseLimits(raw.limits, problems)
    },
    problems: problems
  };
}

// One extra leading label, like a TLS wildcard.
function hostMatches(pattern, host) {
  if (!pattern.startsWith('*.')) return pattern === host;
  const suffix = pattern.slice(1); // ".example.org"
  if (!host.endsWith(suffix)) return false;
  const label = host.slice(0, host.length - suffix.length);
  return label.length > 0 && label.indexOf('.') === -1;
}

function hostAllowed(net, hostname, port) {
  const host = String(hostname).toLowerCase();
  return net.some((e) => hostMatches(e.host, host) && (e.ports == null || e.ports.indexOf(port) !== -1));
}

function isValidPolicyPath(p) {
  return typeof(p) === 'string' &&
         path.posix.isAbsolute(p) &&
         p.split('/').indexOf('..') === -1 &&
         path.posix.normalize(p) === p &&
         (p === '/' || !p.endsWith('/'));
}

function narrowFs(declared, wanted, ignored) {
  const out = [];
  (wanted || []).forEach((w) => {
    const ok = w != null && isValidPolicyPath(w.path) && Object.prototype.hasOwnProperty.call(ACCESS_RANK, w.access) &&
      declared.some((d) => (w.path === d.path || w.path.startsWith(`${d.path}/`)) &&
                           ACCESS_RANK[w.access] <= ACCESS_RANK[d.access]);
    if (ok) out.push({path: w.path, access: w.access});
    else ignored.push(`fs ${JSON.stringify(w)} is wider than the declaration and was ignored`);
  });
  return out;
}

function narrowNet(declared, wanted, ignored) {
  const out = [];
  (wanted || []).forEach((w) => {
    const host = (w != null && typeof(w.host) === 'string') ? w.host.toLowerCase() : null;
    const ports = (w != null && Array.isArray(w.ports)) ? w.ports.slice() : null;
    const ok = host != null && !host.startsWith('*.') && declared.some((d) => {
      if (!hostMatches(d.host, host)) return false;
      if (d.ports == null) return true;
      return ports != null && ports.every((p) => d.ports.indexOf(p) !== -1);
    });
    if (ok) out.push({host: host, ports: ports});
    else ignored.push(`net ${JSON.stringify(w)} is wider than the declaration and was ignored`);
  });
  return out;
}

function narrowLimits(requested, ceilings, entryLimits) {
  const out = {};
  LIMIT_KEYS.forEach((k) => {
    const caps = [DEFAULT_LIMITS[k]];
    if (ceilings != null && Number.isInteger(ceilings[k]) && ceilings[k] > 0) caps[0] = ceilings[k];
    if (entryLimits != null && Number.isInteger(entryLimits[k]) && entryLimits[k] > 0) caps.push(entryLimits[k]);
    const ceiling = Math.min.apply(null, caps);
    out[k] = requested[k] != null ? Math.min(requested[k], ceiling) : ceiling;
  });
  return out;
}

function narrow(declared, entry, ceilings, mode) {
  const ignored = [];
  const limits = narrowLimits(declared.limits, ceilings, entry != null ? entry.limits : null);
  const needsApproval = declared.fs.length > 0 || declared.net.length > 0 || declared.env.length > 0;

  if (entry == null) {
    const grant = (mode !== 'enforce');
    return {
      fs: grant ? declared.fs.map((e) => ({path: e.path, access: e.access})) : [],
      net: grant ? declared.net.map((e) => ({host: e.host, ports: e.ports})) : [],
      envNames: grant ? declared.env.slice() : [], envOverrides: {},
      limits: limits, ignored: ignored, approved: !needsApproval
    };
  }

  const envEntry = (entry.env != null && typeof(entry.env) === 'object') ? entry.env : {};
  const envOverrides = {};
  Object.keys(envEntry).forEach((name) => {
    if (declared.env.indexOf(name) === -1) return ignored.push(`env ${name} is not declared and was ignored`);
    if (typeof(envEntry[name]) === 'string') envOverrides[name] = envEntry[name];
  });

  if (entry.approve === 'as-declared') {
    return {fs: declared.fs.map((e) => ({path: e.path, access: e.access})),
            net: declared.net.map((e) => ({host: e.host, ports: e.ports})),
            envNames: declared.env.slice(), envOverrides: envOverrides,
            limits: limits, ignored: ignored, approved: true};
  }

  return {
    fs: narrowFs(declared.fs, entry.fs, ignored),
    net: narrowNet(declared.net, entry.net, ignored),
    envNames: Object.keys(envEntry).filter((name) => declared.env.indexOf(name) !== -1),
    envOverrides: envOverrides,
    limits: limits, ignored: ignored, approved: true
  };
}

function resolveEnv(envNames, envOverrides, serverEnv) {
  const out = {};
  envNames.forEach((name) => {
    if (envOverrides[name] != null) out[name] = envOverrides[name];
    else if (serverEnv[name] != null) out[name] = serverEnv[name];
  });
  return out;
}

module.exports = {DEFAULT_LIMITS, parseDeclaration, narrow, resolveEnv, hostAllowed};
