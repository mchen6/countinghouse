// The layout lib/fs-broker/identity.js libNamesOf assumes of countinghouse's
// own lib/ (#425's listed-not-changed, now a pin: the register's "post-rel
// libNamesOf pin"). libNamesOf lists the bare names that would resolve to a
// file in lib/ were it a lookup path (reachesLib, which the file broker's
// resolve hook and the lockdown's refusal both use), by a walk that:
// - names a file "x.js" as "x" and "x.json" as "x", nothing else without
//   its extension (a .node file would resolve as "x" and not be listed);
// - names a directory only when it has an index.js or index.json (one
//   whose package.json "main" leads to its entry would not be listed);
// - follows no link (a symlinked file or directory is not walked into);
// - and lib/ today is one directory level deep.
// A change to any of these makes reachesLib miss a name, so this test
// fails first: make libNamesOf list the new shape (and test it), then
// relax the line here that refused it. Server-free.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const LIB = path.join(__dirname, '..', '..', 'lib');

describe('fs-broker 31: lib/ has only the shapes libNamesOf lists', () => {
  const found = {node: [], mains: [], links: [], deep: [], unwalked: []};
  before(() => {
    const walk = (dir, rel, depth) => {
      for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
        const name = rel === '' ? e.name : `${rel}/${e.name}`;
        if (e.isSymbolicLink()) { found.links.push(name); continue; }
        if (e.isDirectory()) {
          if (depth >= 1) found.deep.push(name);
          walk(path.join(dir, e.name), name, depth + 1);
          continue;
        }
        if (!e.isFile()) { found.unwalked.push(name); continue; }
        if (e.name.endsWith('.node')) found.node.push(name);
        if (e.name === 'package.json') {
          let main;
          try { main = JSON.parse(fs.readFileSync(path.join(dir, e.name), 'utf8')).main; } catch (err) { main = '(unreadable)'; }
          if (main !== undefined) found.mains.push(name);
        }
      }
    };
    walk(LIB, '', 0);
  });

  it('no .node file: libNamesOf names "x.node" only as written, while Node resolves a bare "x" to it', () => {
    assert.deepStrictEqual(found.node, []);
  });

  it('no package.json "main": libNamesOf names a directory only by its index.js or index.json', () => {
    assert.deepStrictEqual(found.mains, []);
  });

  it('no symbolic link: libNamesOf follows none, so what one leads to is never listed', () => {
    assert.deepStrictEqual(found.links, []);
  });

  it('nothing but files and directories (a FIFO, a socket, a device)', () => {
    assert.deepStrictEqual(found.unwalked, []);
  });

  it('one directory level: lib/<dir>/<file>, no lib/<dir>/<dir>/', () => {
    assert.deepStrictEqual(found.deep, []);
  });

  // (and the walk above is a real one: it saw lib/'s files and directories)
  it('the walk sees lib/ as it is: its own files and its first-level directories', () => {
    assert.ok(fs.existsSync(path.join(LIB, 'fs-broker', 'identity.js')));
    assert.ok(fs.readdirSync(LIB, {withFileTypes: true}).some((e) => e.isDirectory()), 'lib/ has directories');
  });
});
