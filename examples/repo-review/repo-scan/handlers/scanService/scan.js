// repo-scan: the bulk-data leaf of the repo-review composite demo.
//
// It returns the full text of every matched file. That is the point: this is
// the output the composite tool consumes in-process and never forwards, so the
// demo needs it to be genuinely large rather than a token payload.
//
// Self-contained on purpose -- no npm dependencies and no sibling lib/ file, so
// the whole reader (glob matching, tree walk, budgets) is one file a reader can
// follow top to bottom. A production scanner would reach for a real glob
// library instead.
const fs   = require('fs');
const path = require('path');

// The countinghouse repo this module ships inside:
// examples/repo-review/repo-scan/handlers/scanService/ -> up five.
const DEFAULT_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');

// Source plus manifests. Manifests are in the default set deliberately: the
// composite tool hands package.json and the lockfile to dep-audit out of this
// one scan, so that exactly one module in the chain ever touches the disk.
const DEFAULT_INCLUDE = ['**/*.js', '**/*.json'];

// Kept broad rather than minimal: the default scan target is a real repository
// with a populated node_modules, and walking that would measure npm rather than
// this demo.
const DEFAULT_EXCLUDE = [
  'node_modules/**',
  '.git/**',
  'build/**',
  'dist/**',
  'coverage/**',
  '**/*.min.js',
  '**/*.map',
  'pre-installed-packages/*.tgz'
];

// Budgets exist so a caller cannot turn "scan a directory" into an unbounded
// read of whatever it was pointed at. Hitting one is a truncated result, not an
// error -- a partial review is more useful than a failed one.
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_FILES = 2000;

// A file large enough that including it says more about the file than about the
// repository. Skipped rather than truncated mid-file, so no caller ever sees a
// half-parsed source file.
const MAX_SINGLE_FILE_BYTES = 512 * 1024;

// --- glob matching -------------------------------------------------------
// Enough of glob to be honest about what the patterns mean, and no more:
//   *   any run of characters except /
//   ?   one character except /
//   **  any run of characters including /
//   {a,b} alternation
// Anything else is matched literally.
function globToRegExp(pattern) {
  let out = '';
  let i = 0;

  while (i < pattern.length) {
    const c = pattern[i];

    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // `a/**/b` should also match `a/b`, so swallow the following slash
        // into the optional part rather than requiring it.
        if (pattern[i + 2] === '/') { out += '(?:.*/)?'; i += 3; continue; }
        out += '.*'; i += 2; continue;
      }
      out += '[^/]*'; i += 1; continue;
    }
    if (c === '?')  { out += '[^/]';  i += 1; continue; }
    if (c === '{')  { out += '(?:';   i += 1; continue; }
    if (c === '}')  { out += ')';     i += 1; continue; }
    if (c === ',')  { out += '|';     i += 1; continue; }

    out += c.replace(/[.+^$()|[\]\\/]/g, '\\$&');
    i += 1;
  }
  return new RegExp(`^${out}$`);
}

function compile(patterns) {
  return patterns.map((p) => globToRegExp(p));
}

function matchesAny(compiled, relPath) {
  return compiled.some((re) => re.test(relPath));
}

// --- tree walk -----------------------------------------------------------
// Directories are pruned against the exclude patterns before being descended
// into, which is what keeps `node_modules/**` from costing a full walk of
// node_modules just to reject every path inside it.
// Two probes, because a directory can be excluded by either spelling: a bare
// `build` names the directory itself, while `node_modules/**` only ever matches
// something *inside* it -- and `.*` matching the empty string is what makes the
// trailing-slash probe hit for the second form.
function directoryIsExcluded(excludeRes, relDir) {
  return excludeRes.some((re) => re.test(relDir) || re.test(`${relDir}/`));
}

function walk(root, includeRes, excludeRes, budget, state) {
  const stack = [''];

  while (stack.length > 0) {
    if (state.truncated) return;
    const relDir = stack.pop();
    const absDir = path.join(root, relDir);

    let entries;
    try {
      entries = fs.readdirSync(absDir, {withFileTypes: true});
    } catch (e) {
      // An unreadable directory is a fact about the filesystem, not a reason
      // to fail the whole review.
      state.skipped.push({path: relDir, reason: `readdir failed: ${e.code || e.message}`});
      continue;
    }

    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (state.truncated) return;
      const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`;

      if (entry.isDirectory()) {
        if (!directoryIsExcluded(excludeRes, rel)) stack.push(rel);
        continue;
      }
      // Symlinks are not followed: a link out of the scan root would silently
      // widen what "scan this directory" means.
      if (!entry.isFile()) continue;

      if (!matchesAny(includeRes, rel)) continue;
      if (matchesAny(excludeRes, rel)) continue;

      let stat;
      try {
        stat = fs.statSync(path.join(root, rel));
      } catch (e) {
        state.skipped.push({path: rel, reason: `stat failed: ${e.code || e.message}`});
        continue;
      }
      if (stat.size > MAX_SINGLE_FILE_BYTES) {
        state.skipped.push({path: rel, reason: `larger than ${MAX_SINGLE_FILE_BYTES} bytes`});
        continue;
      }
      if (state.files.length >= budget.maxFiles) {
        state.truncated = true;
        state.truncationReason = `maxFiles budget of ${budget.maxFiles} reached`;
        return;
      }
      if (state.byteCount + stat.size > budget.maxBytes) {
        state.truncated = true;
        state.truncationReason = `maxBytes budget of ${budget.maxBytes} reached`;
        return;
      }

      let content;
      try {
        content = fs.readFileSync(path.join(root, rel), 'utf8');
      } catch (e) {
        state.skipped.push({path: rel, reason: `read failed: ${e.code || e.message}`});
        continue;
      }

      // Byte length, not string length: the demo's whole point is a byte
      // comparison, and multi-byte source files would inflate one side of it.
      const bytes = Buffer.byteLength(content, 'utf8');
      state.byteCount += bytes;
      state.files.push({path: rel, bytes: bytes, content: content});
    }
  }
}

function resolveRoot(input) {
  if (input == null || input.path == null) return DEFAULT_ROOT;
  if (typeof input.path !== 'string' || input.path.trim() === '') {
    throw new DeviceError('ARGUMENTS_INVALID', 'path must be a non-empty string');
  }
  const resolved = path.resolve(input.path);

  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch (e) {
    throw new DeviceError('ARGUMENTS_INVALID', `cannot stat ${resolved}: ${e.code || e.message}`);
  }
  if (!stat.isDirectory()) {
    throw new DeviceError('ARGUMENTS_INVALID', `${resolved} is not a directory`);
  }
  return resolved;
}

function positiveIntOr(value, fallback) {
  if (value == null) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new DeviceError('ARGUMENTS_INVALID', `expected a positive integer, got ${JSON.stringify(value)}`);
  }
  return value;
}

module.exports = async (input, ctx) => {
  const root    = resolveRoot(input);
  const include = (input != null && Array.isArray(input.include) && input.include.length > 0)
                    ? input.include : DEFAULT_INCLUDE;
  const exclude = (input != null && Array.isArray(input.exclude))
                    ? input.exclude : DEFAULT_EXCLUDE;

  const budget = {
    maxBytes: positiveIntOr(input != null ? input.maxBytes : null, DEFAULT_MAX_BYTES),
    maxFiles: positiveIntOr(input != null ? input.maxFiles : null, DEFAULT_MAX_FILES)
  };

  const state = {files: [], byteCount: 0, truncated: false, truncationReason: null, skipped: []};
  walk(root, compile(include), compile(exclude), budget, state);

  ctx.log(`repo-scan: ${state.files.length} files, ${state.byteCount} bytes from ${root}` +
          `${state.truncated ? ` (truncated: ${state.truncationReason})` : ''}`);

  return {
    output: {
      root:             root,
      fileCount:        state.files.length,
      byteCount:        state.byteCount,
      truncated:        state.truncated,
      truncationReason: state.truncationReason,
      files:            state.files
    }
  };
};
