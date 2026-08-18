// dep-audit: offline dependency hygiene, from manifest text alone.
//
// Deliberately NOT `npm audit`. There is no network access anywhere in this
// file, which means there is no advisory database, which means this module
// cannot tell you whether a dependency is vulnerable -- only how the manifest
// declares it. Everything it reports is derivable from the two strings it is
// handed. See api.json's description, which says the same thing to the model.
//
// No npm dependencies either, including no semver: "is this range exactly one
// version" is a regex, and pulling in a resolver would hide the fact that the
// analysis really is this small.
const SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

const NOTE_NO_NETWORK =
  'No network access: this is a manifest hygiene check, not a vulnerability ' +
  'scan. It knows nothing about CVEs or advisories.';

// An exact version is a bare semver, optionally with a prerelease/build tag:
// 1.2.3, 1.2.3-rc.1, 1.2.3+build.5. Anything else is a range.
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

// Specifiers that skip the registry's version resolution altogether. Each is
// legitimate somewhere and a supply-chain question everywhere: what gets
// installed is decided by something other than a published, immutable version.
const SUSPICIOUS = [
  {test: (r) => r === '*' || r === '' || r === 'x',
   reason: 'wildcard: installs whatever the latest published version happens to be', severity: 'high'},
  {test: (r) => r === 'latest' || r === 'next',
   reason: 'dist-tag instead of a version: what installs changes when the tag moves', severity: 'high'},
  {test: (r) => /^(?:git|git\+ssh|git\+https?|ssh):\/\//.test(r) || /^[^/\s]+\/[^/\s]+#/.test(r) || /^github:/.test(r),
   reason: 'git specifier: not a registry artifact, and mutable unless pinned to a commit SHA', severity: 'high'},
  {test: (r) => /^https?:\/\//.test(r),
   reason: 'http(s) tarball URL: bypasses the registry, with no integrity guarantee from it', severity: 'high'},
  {test: (r) => /^(?:file|link):/.test(r),
   reason: 'local path: resolves to whatever is on the installing machine', severity: 'medium'},
  {test: (r) => /^>=?\s*\d/.test(r) && !/[<\s]/.test(r.replace(/^>=?\s*/, '')),
   reason: 'unbounded lower bound: no upper limit, so a future major version satisfies it', severity: 'medium'},
  {test: (r) => r.indexOf('||') !== -1,
   reason: 'alternation: more than one disjoint version range satisfies this', severity: 'low'}
];

// Which flavour of non-exact, for callers that want to distinguish "caret, like
// almost every npm project" from "an open range".
function rangeKind(range) {
  if (range.startsWith('^')) return 'caret';
  if (range.startsWith('~')) return 'tilde';
  if (range === '*' || range === '' || range === 'x') return 'wildcard';
  if (range === 'latest' || range === 'next') return 'dist-tag';
  if (/^\d+\.\d+\.x$/.test(range) || /^\d+\.x$/.test(range)) return 'x-range';
  if (/^(?:npm|workspace):/.test(range)) return 'alias';
  if (/^(?:git|ssh|https?|file|link|github)[+:]/.test(range)) return 'url-or-path';
  if (/[<>=]/.test(range)) return 'comparator';
  return 'other';
}

function parseJSON(text, label) {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new DeviceError('ARGUMENTS_INVALID', `${label} is not valid JSON: ${e.message}`);
  }
}

// npm lockfileVersion 2 and 3 use `packages` keyed by node_modules path; v1
// used `dependencies` keyed by name. Both are counted; neither is walked
// recursively, because in v1 nesting is the exception and in v2/v3 the flat map
// is already complete.
function analyzeNpmLock(lock, directNames, result, notes) {
  result.format = 'npm-json';
  result.lockfileVersion = Number.isInteger(lock.lockfileVersion) ? lock.lockfileVersion : null;

  let entries = null;
  if (lock.packages != null && typeof lock.packages === 'object') {
    // The root project itself is the "" key; it is not a resolved dependency.
    entries = Object.keys(lock.packages).filter((k) => k !== '');
    result.resolvedPackages = entries.length;
  } else if (lock.dependencies != null && typeof lock.dependencies === 'object') {
    entries = Object.keys(lock.dependencies);
    result.resolvedPackages = entries.length;
    notes.push('Lockfile is the pre-v7 (lockfileVersion 1) shape; nested transitive entries are not counted.');
  } else {
    result.resolvedPackages = 0;
    notes.push('Lockfile parsed but contains neither a `packages` nor a `dependencies` map.');
    return;
  }

  // v2/v3 keys are paths ("node_modules/foo", "node_modules/a/node_modules/b").
  // Take the last path segment so a direct dependency is found wherever it was
  // hoisted to.
  const resolvedNames = new Set();
  for (const key of entries) {
    const at = key.lastIndexOf('node_modules/');
    resolvedNames.add(at === -1 ? key : key.slice(at + 'node_modules/'.length));
  }
  result.missingFromLock = directNames.filter((n) => !resolvedNames.has(n)).sort();
}

function analyzeLockfile(lockText, lockName, directNames, notes) {
  const result = {
    present: false, name: null, format: null, lockfileVersion: null,
    resolvedPackages: null, missingFromLock: []
  };

  if (lockText == null || typeof lockText !== 'string' || lockText.trim() === '') {
    notes.push('No lockfile supplied: cannot tell what actually installs, only what the manifest asks for.');
    return result;
  }

  result.present = true;
  result.name = (typeof lockName === 'string' && lockName !== '') ? lockName : 'package-lock.json';

  if (result.name.endsWith('yarn.lock') || lockText.startsWith('# yarn lockfile')) {
    result.format = 'yarn-classic';
    // One entry per `key@range:` header at column 0. Counted, not parsed:
    // yarn.lock is not JSON and a real parser is out of scope for a demo.
    const headers = lockText.match(/^[^\s#].*:\s*$/gm);
    result.resolvedPackages = headers != null ? headers.length : 0;
    notes.push('yarn.lock is counted, not parsed: entry-to-dependency matching is not implemented, so missingFromLock is left empty.');
    return result;
  }

  analyzeNpmLock(parseJSON(lockText, result.name), directNames, result, notes);
  return result;
}

module.exports = async (input, ctx) => {
  if (input == null || typeof input.manifest !== 'string') {
    throw new DeviceError('ARGUMENTS_INVALID', 'manifest must be the text of a package.json');
  }

  const manifest = parseJSON(input.manifest, 'manifest');
  if (manifest == null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new DeviceError('ARGUMENTS_INVALID', 'manifest parsed to something other than a JSON object');
  }

  const notes      = [NOTE_NO_NETWORK];
  const counts     = {dependencies: 0, devDependencies: 0, peerDependencies: 0, optionalDependencies: 0, total: 0};
  const unpinned   = [];
  const suspicious = [];
  const directNames = [];

  for (const section of SECTIONS) {
    const deps = manifest[section];
    if (deps == null || typeof deps !== 'object' || Array.isArray(deps)) continue;

    for (const name of Object.keys(deps).sort()) {
      const raw = deps[name];
      // A non-string specifier is malformed rather than merely unusual; report
      // it as a finding instead of coercing it into one.
      const range = (typeof raw === 'string') ? raw.trim() : String(raw);

      counts[section]++;
      counts.total++;
      if (section === 'dependencies' || section === 'optionalDependencies') directNames.push(name);

      if (typeof raw !== 'string') {
        suspicious.push({name: name, range: range.slice(0, 200), section: section,
                         reason: `specifier is ${typeof raw}, not a string`, severity: 'high'});
        continue;
      }

      if (!EXACT_VERSION.test(range)) {
        unpinned.push({name: name, range: range.slice(0, 200), section: section, kind: rangeKind(range)});
      }
      // First matching rule wins: the rules are ordered most to least specific,
      // and one specifier flagged three ways is noise, not three findings.
      const hit = SUSPICIOUS.find((rule) => rule.test(range));
      if (hit != null) {
        suspicious.push({name: name, range: range.slice(0, 200), section: section,
                         reason: hit.reason, severity: hit.severity});
      }
    }
  }

  const lockfile = analyzeLockfile(input.lockfile, input.lockfileName, directNames, notes);

  if (lockfile.present && lockfile.missingFromLock.length > 0) {
    notes.push(`${lockfile.missingFromLock.length} direct dependency/ies are declared in the manifest but absent from the lockfile; the lockfile may be stale.`);
  }

  ctx.log(`dep-audit: ${counts.total} declared deps, ${unpinned.length} unpinned, ${suspicious.length} suspicious`);

  return {
    output: {
      packageName:    (typeof manifest.name === 'string') ? manifest.name : null,
      packageVersion: (typeof manifest.version === 'string') ? manifest.version : null,
      counts:         counts,
      unpinned:       unpinned,
      suspicious:     suspicious,
      lockfile:       lockfile,
      notes:          notes
    }
  };
};
