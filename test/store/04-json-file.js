'use strict';

// LM1 B2, Task 3 (plan 2026-11-11-lm1-store-and-identity.md, Review Focus
// 1-3): the local store's persisted maps. Several processes may share one
// --storePath (reviewer's ruling, 2026-11-11): every write takes the store
// lock, re-reads the file, applies this process's dirty keys over it and
// renames a temp file into place, so no file is replaced whole.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawn, spawnSync} = require('child_process');
const {openJsonFile, withStoreLock} = require('../../lib/store/json-file');

const ROOT = path.resolve(__dirname, '../..');
const MOD = path.join(ROOT, 'lib', 'store', 'json-file');

function tmpStore() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ch-store-04-'));
}

function child(script) {
  return spawnSync(process.execPath, ['-e', `const {openJsonFile, withStoreLock, flushAllOnExit} = require(${JSON.stringify(MOD)});\n${script}`],
    {cwd: ROOT, encoding: 'utf8', timeout: 30000});
}

describe('store 04: the persisted maps (LM1 B2)', function() {
  this.timeout(60000);

  it('round-trips, and leaves no temp file', () => {
    const dir = tmpStore();
    const file = path.join(dir, 'm.json');
    const a = openJsonFile(file);
    a.set('k', {n: 1});
    a.flush();
    a.close();
    assert.deepStrictEqual(openJsonFile(file).data, {k: {n: 1}});
    assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f.includes('.tmp-')), []);
  });

  it('writes once for several changes within the debounce', async () => {
    const dir = tmpStore();
    const file = path.join(dir, 'm.json');
    const renames = [];
    const rename = fs.renameSync;
    fs.renameSync = (...a) => { renames.push(a[1]); return rename(...a); };
    try {
      const f = openJsonFile(file, {debounceMs: 100});
      f.set('a', 1);
      f.set('b', 2);
      f.delete('a');
      await new Promise((resolve) => setTimeout(resolve, 300));
      f.close();
    } finally {
      fs.renameSync = rename;
    }
    assert.strictEqual(renames.filter((r) => r === file).length, 1);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {b: 2});
  });

  it('moves a corrupt file aside and starts empty', () => {
    const dir = tmpStore();
    const file = path.join(dir, 'm.json');
    fs.writeFileSync(file, '{"half": ');
    assert.deepStrictEqual(openJsonFile(file).data, {});
    assert.strictEqual(fs.readdirSync(dir).filter((f) => f.startsWith('m.json.corrupt-')).length, 1);
  });

  it('two processes writing disjoint keys to one store end with both sets on disk', async () => {
    const dir = tmpStore();
    const file = path.join(dir, 'm.json');
    const writer = (tag) => new Promise((resolve, reject) => {
      const p = spawn(process.execPath, ['-e', `
        const {openJsonFile} = require(${JSON.stringify(MOD)});
        const f = openJsonFile(${JSON.stringify(file)}, {debounceMs: 1});
        for (let i = 0; i < 200; i++) { f.set('${tag}' + i, i); if (i % 10 === 0) f.flush(); }
        f.flush();
      `], {stdio: ['ignore', 'ignore', 'pipe']});
      let err = '';
      p.stderr.on('data', (c) => { err += c; });
      p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(err))));
    });
    await Promise.all([writer('a'), writer('b')]);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(Object.keys(data).length, 400);
  });

  it('a key both processes set ends with the later write, and the other keys stay', () => {
    const dir = tmpStore();
    const file = path.join(dir, 'm.json');
    const a = openJsonFile(file);
    const b = openJsonFile(file);
    a.set('shared', 'a');
    a.set('onlyA', 1);
    a.flush();
    b.set('shared', 'b');
    b.flush();
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {shared: 'b', onlyA: 1});
  });

  it('takes over a lock whose process is gone', () => {
    const dir = tmpStore();
    fs.writeFileSync(path.join(dir, '.lock'), JSON.stringify({pid: 999999, startMs: 1}));
    const f = openJsonFile(path.join(dir, 'm.json'));
    f.set('k', 1);
    f.flush();
    assert.strictEqual(fs.existsSync(path.join(dir, '.lock')), false);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'm.json'), 'utf8')), {k: 1});
  });

  it('waits for a lock another process holds, then writes', async () => {
    const dir = tmpStore();
    const holder = spawn(process.execPath, ['-e', `
      const {withStoreLock} = require(${JSON.stringify(MOD)});
      withStoreLock(${JSON.stringify(dir)}, () => { process.stdout.write('held\\n'); const t = Date.now(); while (Date.now() - t < 400) {} });
    `], {stdio: ['ignore', 'pipe', 'inherit']});
    await new Promise((resolve) => holder.stdout.once('data', resolve));
    const f = openJsonFile(path.join(dir, 'm.json'));
    f.set('k', 1);
    const started = Date.now();
    f.flush();
    assert.ok(Date.now() - started >= 100, 'the flush waited for the lock');
    await new Promise((resolve) => holder.on('exit', resolve));
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'm.json'), 'utf8')), {k: 1});
  });

  it('flushes on SIGTERM', async () => {
    const dir = tmpStore();
    const file = path.join(dir, 'm.json');
    const p = spawn(process.execPath, ['-e', `
      const {openJsonFile, flushAllOnExit} = require(${JSON.stringify(MOD)});
      flushAllOnExit();
      const f = openJsonFile(${JSON.stringify(file)}, {debounceMs: 60000});
      f.set('k', 'kept');
      process.stdout.write('set\\n');
      setInterval(() => {}, 1000);
    `], {stdio: ['ignore', 'pipe', 'inherit']});
    await new Promise((resolve) => p.stdout.once('data', resolve));
    p.kill('SIGTERM');
    await new Promise((resolve) => p.on('exit', resolve));
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {k: 'kept'});
  });

  it('writes the files and the store directory for the owner only', () => {
    if (process.platform === 'win32') return;
    const dir = path.join(tmpStore(), 'store');
    const f = openJsonFile(path.join(dir, 'm.json'));
    f.set('k', 1);
    f.flush();
    assert.strictEqual(fs.statSync(dir).mode & 0o777, 0o700);
    assert.strictEqual(fs.statSync(path.join(dir, 'm.json')).mode & 0o777, 0o600);
  });

  it('withStoreLock runs its function and removes the lock', () => {
    const dir = tmpStore();
    assert.strictEqual(withStoreLock(dir, () => 42), 42);
    assert.strictEqual(fs.existsSync(path.join(dir, '.lock')), false);
    void child;
  });
});
