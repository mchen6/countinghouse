#!/usr/bin/env node
// Converts a 5.x device module to the 6.0.0 shape:
//
//   index.js  + device.js + com-<ns>-<service>-<action>.js
//     ->      handlers/<serviceShortName>/<actionName>.js
//
// index.js and device.js are boilerplate once api.json already declares the
// services and actions (see docs/design-decisions.md, "Module shape 6.0.0"),
// so they are removed rather than rewritten. The handler files themselves are
// *moved*, not regenerated: their bodies are the only part that was ever the
// author's, and moving keeps the diff reviewable and the history intact. Only
// the signature line and `args.input` references are rewritten.
//
// Deliberately conservative. Anything outside the boilerplate shape -- real
// discovery logic, a constructor that builds ServiceClients, a handler that
// reads args beyond `input` -- is refused by name rather than guessed at, and
// the module is left exactly as it was. A migrator that half-converts a module
// is worse than one that declines: the failure would surface later as a
// missing tool.
//
// Usage:
//   node bin/countinghouse-migrate-module.js <modulePath> [--dry-run]
const fs   = require('fs');
const path = require('path');

const SERVICE_URN_SEP = ':serviceID:';

function fail(modulePath, reason, fix) {
  const err = new Error(`${path.basename(modulePath)}: ${reason}${fix != null ? `\n  -> ${fix}` : ''}`);
  err.migrationRefusal = true;
  throw err;
}

// comments hide most of the shapes below; strip them before pattern matching
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

function shortNameOf(urn) {
  const at = urn.lastIndexOf(SERVICE_URN_SEP);
  return (at === -1) ? null : urn.slice(at + SERVICE_URN_SEP.length);
}

// index.js must be the boilerplate: answer 'discover' by emitting exactly one
// deviceonline with a single new Device(). Anything else is real discovery,
// which 6.0.0 still supports and which this tool must not flatten into a
// single static device.
function checkIndexIsBoilerplate(modulePath) {
  const indexPath = path.join(modulePath, 'index.js');
  if (!fs.existsSync(indexPath)) return;   // already convention-shaped

  const src = stripComments(fs.readFileSync(indexPath, 'utf8'));

  const emits = src.match(/\.emit\(\s*['"]deviceonline['"]/g) || [];
  if (emits.length !== 1) {
    fail(modulePath,
      `index.js emits 'deviceonline' ${emits.length} time(s); the boilerplate shape emits it exactly once`,
      'this looks like real dynamic discovery. 6.0.0 still supports it unchanged -- keep index.js as it is and migrate nothing.');
  }
  if (/\bfor\s*\(|\bwhile\s*\(|\.forEach\(|\bmap\(/.test(src)) {
    fail(modulePath,
      'index.js contains a loop, so it may expose a number of devices decided at runtime',
      'that is the dynamic-discovery path, which 6.0.0 keeps. Migrate by hand, or leave it alone.');
  }
  if (/process\.env|readFileSync|require\(['"](?!util|events)/.test(src.replace(/CHUtil\.loadFile/g, ''))) {
    fail(modulePath,
      'index.js reads configuration or requires modules beyond util/events',
      'its discovery is not boilerplate. Migrate by hand.');
  }
}

// device.js is expected to be: read api.json, CHDevice.call, a run of
// setAction lines, inherits, _getDeviceRootSchema. Anything else is state or
// behaviour that has nowhere to go in a handler map.
function readDeviceJs(modulePath) {
  const devicePath = path.join(modulePath, 'device.js');
  if (!fs.existsSync(devicePath)) return null;

  const raw = fs.readFileSync(devicePath, 'utf8');
  const src = stripComments(raw);

  if (/createServiceClient/.test(src)) {
    fail(modulePath,
      'device.js builds a ServiceClient in its constructor',
      'in 6.0.0 a composing module creates clients per call via ctx.serviceClient({deviceID, serviceID, as}), ' +
      'so the caller can be billed for each hop. That is a behavioural change, not a move -- migrate this one by hand. ' +
      'See docs/composite-tools.md.');
  }

  // <ref> = CHUtil.loadFile(`${__dirname}/<file>`)[.<prop>]
  const loads = {};
  const loadRe = /(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*CHUtil\.loadFile\(\s*`\$\{__dirname\}\/([^`]+)`\s*\)(?:\.([A-Za-z0-9_$]+))?/g;
  let m;
  while ((m = loadRe.exec(src)) !== null) {
    loads[m[1]] = {file: m[2], prop: m[3] || null};
  }

  // this.setAction('<urn>', '<action>', <ref>.bind(this))
  const actions = [];
  const setRe = /this\.setAction\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*,\s*([A-Za-z0-9_$]+)\s*(?:\.bind\(\s*this\s*\))?\s*\)/g;
  while ((m = setRe.exec(src)) !== null) {
    actions.push({urn: m[1], actionName: m[2], ref: m[3]});
  }

  if (actions.length === 0) {
    fail(modulePath, 'device.js registers no actions with setAction',
      'nothing to migrate; check that this is a 5.x module.');
  }
  return {raw: raw, actions: actions, loads: loads};
}

// Rewrite one handler's signature and its `args` references.
//   function f(args, callback)  ->  module.exports = (input, ctx, callback) =>
//   async function f(args)      ->  module.exports = async (input, ctx) =>
function rewriteHandler(modulePath, file, src) {
  const exported = src.match(/module\.exports\s*=\s*([A-Za-z0-9_$]+)\s*;?/);
  if (exported == null) {
    fail(modulePath, `${file} has no \`module.exports = <name>\` to identify its handler`,
      'give the file a single named export, or migrate it by hand.');
  }
  const name = exported[1];

  const declRe = new RegExp(`(async\\s+)?function\\s+${name}\\s*\\(([^)]*)\\)`);
  const decl = src.match(declRe);
  if (decl == null) {
    fail(modulePath, `${file} exports ${name}, but no \`function ${name}(...)\` declaration was found`,
      'migrate this file by hand.');
  }

  const isAsync = decl[1] != null;
  const params  = decl[2].split(',').map((p) => p.trim()).filter((p) => p !== '');
  const argsVar = params[0];
  const cbVar   = params[1] || null;

  if (argsVar == null) {
    fail(modulePath, `${file}'s handler takes no arguments`, 'migrate this file by hand.');
  }

  // Anything beyond args.input has no mechanical equivalent: ctx, httpHeaders
  // and jobID all moved onto ctx with different names.
  const otherUse = new RegExp(`\\b${argsVar}\\s*\\.\\s*(?!input\\b)([A-Za-z0-9_$]+)`).exec(src);
  if (otherUse != null) {
    fail(modulePath, `${file} reads \`${argsVar}.${otherUse[1]}\`, not just \`${argsVar}.input\``,
      `in 6.0.0 that is on ctx (ctx.httpHeaders, ctx.job.id, ctx.caller). Migrate this file by hand.`);
  }

  const newSig = isAsync
    ? `module.exports = async (input, ctx) =>`
    : `module.exports = (input, ctx${cbVar != null ? `, ${cbVar}` : ''}) =>`;

  let out = src.replace(declRe, newSig);

  // `const input = args.input;` is the common first line, and rewriting
  // args.input in place would turn it into `const input = input;` -- a
  // self-referential declaration that throws at call time. The parameter now
  // provides it, so drop the line instead of rewriting it.
  out = out.replace(new RegExp(`^[ \\t]*(?:const|let|var)\\s+input\\s*=\\s*${argsVar}\\s*\\.\\s*input\\s*;[ \\t]*\\r?\\n`, 'gm'), '');

  out = out.replace(new RegExp(`\\b${argsVar}\\s*\\.\\s*input\\b`, 'g'), 'input');

  // Any other local called `input`, `ctx`, or the callback name would now
  // collide with a parameter. Refuse rather than emit code that does not run.
  for (const reserved of ['input', 'ctx'].concat(cbVar != null ? [cbVar] : [])) {
    if (new RegExp(`(?:const|let|var)\\s+${reserved}\\b`).test(out)) {
      fail(modulePath, `${file} declares a local named \`${reserved}\`, which collides with the new parameter list`,
        'rename that local, then re-run the migrator.');
    }
  }
  // the trailing `module.exports = name;` is now redundant
  out = out.replace(/\n*module\.exports\s*=\s*[A-Za-z0-9_$]+\s*;?\s*$/, '\n');

  return `${out.trimEnd()  }\n`;
}

function migrate(modulePath, dryRun) {
  if (!fs.existsSync(path.join(modulePath, 'api.json'))) {
    fail(modulePath, 'no api.json here', 'point this at a module directory.');
  }
  if (fs.existsSync(path.join(modulePath, 'handlers'))) {
    return {status: 'already-migrated', writes: [], removals: []};
  }

  checkIndexIsBoilerplate(modulePath);
  const device = readDeviceJs(modulePath);
  if (device == null) {
    return {status: 'already-migrated', writes: [], removals: []};
  }

  const writes   = [];
  const removals = [];
  const touchedSources = new Set();

  for (const a of device.actions) {
    const short = shortNameOf(a.urn);
    if (short == null) {
      fail(modulePath, `service URN "${a.urn}" has no "${SERVICE_URN_SEP}" segment`,
        'a handler map keys on the short name after that separator.');
    }

    const load = device.loads[a.ref];
    if (load == null) {
      fail(modulePath, `setAction uses "${a.ref}", which no CHUtil.loadFile line defines`,
        'migrate this module by hand.');
    }

    // an intermediate re-export file (com-<ns>-<service>.js) names the real
    // file via .prop; resolve to whichever file actually holds the function
    let sourceFile = load.file;
    if (load.prop != null) {
      const intermediate = fs.readFileSync(path.join(modulePath, load.file), 'utf8');
      const re = new RegExp(`(?:const|let|var)\\s+${load.prop}\\s*=\\s*CHUtil\\.loadFile\\(\\s*\`\\$\\{__dirname\\}\\/([^\`]+)\``);
      const inner = stripComments(intermediate).match(re);
      if (inner == null) {
        fail(modulePath, `${load.file} does not resolve "${load.prop}" to a file`,
          'migrate this module by hand.');
      }
      sourceFile = inner[1];
      removals.push(load.file);
    }

    const srcPath = path.join(modulePath, sourceFile);
    if (!fs.existsSync(srcPath)) {
      fail(modulePath, `${sourceFile} referenced by setAction does not exist`, 'migrate this module by hand.');
    }

    writes.push({
      to:   path.join('handlers', short, `${a.actionName}.js`),
      body: rewriteHandler(modulePath, sourceFile, fs.readFileSync(srcPath, 'utf8'))
    });
    touchedSources.add(sourceFile);
  }

  for (const f of touchedSources) removals.push(f);
  removals.push('device.js');
  if (fs.existsSync(path.join(modulePath, 'index.js'))) removals.push('index.js');

  if (dryRun !== true) {
    for (const w of writes) {
      const abs = path.join(modulePath, w.to);
      fs.mkdirSync(path.dirname(abs), {recursive: true});
      fs.writeFileSync(abs, w.body);
    }
    for (const r of new Set(removals)) {
      try { fs.unlinkSync(path.join(modulePath, r)); } catch (e) { /* already gone */ }
    }
    // "main" pointed at device.js or index.js, neither of which exists now;
    // the handlers/ tree is found by convention instead.
    const pkgPath = path.join(modulePath, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (pkg.main != null) {
      delete pkg.main;
      fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
    }
  }

  return {status: 'migrated', writes: writes, removals: [...new Set(removals)]};
}

function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.indexOf('--dry-run') !== -1;
  const targets = argv.filter((a) => a !== '--dry-run');

  if (targets.length === 0) {
    console.error('Usage: node bin/countinghouse-migrate-module.js <modulePath> [...] [--dry-run]');
    process.exit(1);
  }

  let failed = 0;
  for (const t of targets) {
    try {
      const r = migrate(t, dryRun);
      if (r.status === 'already-migrated') {
        console.log(`${t}: already in the 6.0.0 shape, nothing to do`);
        continue;
      }
      console.log(`${t}: ${dryRun ? 'would migrate' : 'migrated'}`);
      r.writes.forEach((w) => console.log(`  + ${w.to}`));
      r.removals.forEach((x) => console.log(`  - ${x}`));
    } catch (e) {
      failed++;
      console.error(`${e.migrationRefusal === true ? 'REFUSED' : 'ERROR'}: ${e.message}`);
    }
  }
  process.exit(failed > 0 ? 1 : 0);
}

if (require.main === module) main();

module.exports = {migrate: migrate, rewriteHandler: rewriteHandler, shortNameOf: shortNameOf};
