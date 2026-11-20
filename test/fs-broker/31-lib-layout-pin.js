// What lib/fs-broker/identity.js libNamesOf lists of countinghouse's own
// lib/, pinned (#425's listed-not-changed: the register's "post-rel
// libNamesOf pin"). libNamesOf lists the bare names that would resolve to a
// file in lib/ were it a lookup path; reachesLib, which the file broker's
// resolve hook and the lockdown's refusal both use, answers from that list.
// A name Node would resolve into lib/ that the list misses is a gap in both.
//
// Two checks:
// - differential: in a worker (libNamesOf lists nothing on the main thread),
//   every name lib/'s files and directories offer -- each file as written
//   and without its extension, each directory -- that Node's own resolver
//   (Module._findPath with lib/ as the lookup path, the NODE_PATH route)
//   resolves into lib/ must be one reachesLib says reaches lib/. It catches
//   a shape nobody listed below (a package.json "exports", say);
// - the shapes libNamesOf's walk does not handle, each its own line, so a
//   failure says what was added: a package.json (a "main" or "exports"
//   entry), a file whose extension is .js, .json or .node in another case or
//   .node itself (a case-insensitive file system resolves "x" to x.JS), a
//   symbolic link (not walked), anything not a file or directory, and a
//   directory deeper than libNamesOf's walk (8 levels).
// When one fails: make libNamesOf list the new shape, with a test, then
// relax the line here. Server-free.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {Worker} = require('worker_threads');

const ROOT = path.join(__dirname, '..', '..');
const LIB = path.join(ROOT, 'lib');
const MAX_DEPTH = 8;   // libNamesOf's walk (lib/fs-broker/identity.js)

describe('fs-broker 31: every name that resolves into lib/ is one libNamesOf lists', () => {
  const found = {packageJson: [], extension: [], links: [], unwalked: [], deep: [], files: [], dirs: []};
  before(() => {
    const walk = (dir, rel, depth) => {
      for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
        const name = rel === '' ? e.name : `${rel}/${e.name}`;
        if (e.isSymbolicLink()) { found.links.push(name); continue; }
        if (e.isDirectory()) {
          found.dirs.push(name);
          if (depth + 1 > MAX_DEPTH) { found.deep.push(name); continue; }
          walk(path.join(dir, e.name), name, depth + 1);
          continue;
        }
        if (!e.isFile()) { found.unwalked.push(name); continue; }
        found.files.push(name);
        if (e.name.toLowerCase() === 'package.json') found.packageJson.push(name);
        const ext = path.extname(e.name);
        if (/^\.(js|json|node)$/i.test(ext) && ext !== '.js' && ext !== '.json') found.extension.push(name);
      }
    };
    walk(LIB, '', 0);
  });

  it('the walk saw lib/ as it is (so the empty lists below mean something)', () => {
    assert.ok(found.files.includes('fs-broker/identity.js'), 'lib/fs-broker/identity.js');
    assert.ok(found.files.length > 50 && found.dirs.length > 0, `${found.files.length} files, ${found.dirs.length} directories`);
  });

  it('no package.json: libNamesOf names a directory only by its index.js or index.json, never by a "main" or "exports"', () => {
    assert.deepStrictEqual(found.packageJson, []);
  });

  it('no .node file, and no .js or .json in another case: libNamesOf strips only ".js" and ".json" as written', () => {
    assert.deepStrictEqual(found.extension, []);
  });

  it('no symbolic link: libNamesOf follows none, so what one leads to is never listed', () => {
    assert.deepStrictEqual(found.links, []);
  });

  it('nothing but files and directories (a FIFO, a socket, a device)', () => {
    assert.deepStrictEqual(found.unwalked, []);
  });

  it(`no directory deeper than libNamesOf walks (${MAX_DEPTH} levels)`, () => {
    assert.deepStrictEqual(found.deep, []);
  });

  it('differential: each name Node resolves into lib/ (lib/ as the lookup path) is one reachesLib says reaches lib/', async function() {
    this.timeout(60000);
    const names = new Set();
    for (const f of found.files) {
      names.add(f);
      const ext = path.extname(f);
      if (ext !== '') names.add(f.slice(0, -ext.length));
    }
    for (const d of found.dirs) names.add(d);
    const missed = await new Promise((resolve, reject) => {
      const w = new Worker(`
        const {parentPort, workerData} = require('worker_threads');
        const path = require('path');
        const Module = require('module');
        const {reachesLib} = require(path.join(workerData.root, 'lib', 'fs-broker', 'identity.js'));
        const inLib = (p) => typeof(p) === 'string' && (p === workerData.lib || p.startsWith(workerData.lib + path.sep));
        const missed = [];
        let resolved = 0;
        for (const name of workerData.names) {
          let to = false;
          try { to = Module._findPath(name, [workerData.lib], false); } catch (e) { to = false; }
          if (!inLib(to)) continue;
          resolved++;
          if (!reachesLib(name)) missed.push(name);
        }
        parentPort.postMessage({missed, resolved});
      `, {eval: true, workerData: {root: ROOT, lib: LIB, names: [...names]}});
      w.once('message', (m) => { w.terminate(); resolve(m); });
      w.once('error', reject);
    });
    assert.ok(missed.resolved > 50, `Node resolved only ${missed.resolved} of the names into lib/`);
    assert.deepStrictEqual(missed.missed, [], 'names Node resolves into lib/ that reachesLib misses');
  });
});
