'use strict';
// The product is in English (the maintainer's rule, 2026-11-22): no Chinese
// in anything delivered or shown to users, so none in a tracked file's name
// or text, nor inside a package tarball the runtime ships. A test or a
// detector that needs such a character as input writes it as a \u escape, with
// the same code point; a module's own text may still be in any language.
// Binary files are skipped, as git's own text detection skips them (a byte
// search over compressed data finds characters that are not there).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const {spawnSync} = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
// Han in every block (radicals, extensions, compatibility forms), bopomofo,
// strokes, CJK punctuation and the fullwidth and halfwidth forms. In escapes:
// this file is one of those it reads.
const CHINESE = /[\p{Script=Han}\p{Script=Bopomofo}\u31c0-\u31ef\u3000-\u303f\uff00-\uffef]/u;
const MAX_SAID = 25;

// the text's lines holding such a character, as `name:line`
function hits(name, text) {
  if (!CHINESE.test(text)) return [];
  const out = [];
  text.split('\n').forEach((line, i) => { if (CHINESE.test(line)) out.push(`${name}:${i + 1}`); });
  return out;
}
// UTF-16 by its byte order mark: text, for all the NULs it holds
const isUtf16 = (bytes) => bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff));
const isBinary = (bytes) => !isUtf16(bytes) && bytes.subarray(0, 8000).includes(0);
function textOf(bytes) {
  if (!isUtf16(bytes)) return bytes.toString('utf8');
  if (bytes[0] === 0xff) return bytes.toString('utf16le');
  return Buffer.from(bytes).swap16().toString('utf16le');
}

// A ustar archive's regular files -> [{name, bytes}]
function tarFiles(archive) {
  const out = [];
  for (let at = 0; at + 512 <= archive.length;) {
    const header = archive.subarray(at, at + 512);
    if (header[0] === 0) break;
    const field = (from, to) => header.subarray(from, to).toString('utf8').replace(/\0.*$/s, '');
    const prefix = field(345, 500);
    const name = prefix !== '' ? `${prefix}/${field(0, 100)}` : field(0, 100);
    const size = parseInt(field(124, 136).trim(), 8);
    assert.ok(Number.isSafeInteger(size) && size >= 0, `${name}: a size that is not one`);
    // (a pax or GNU long-name record would hide the real name from this
    // reader: refused, never passed over)
    assert.ok([0, 48, 53].includes(header[156]), `${name}: a tar entry of type ${header[156]} this test does not read`);
    if (header[156] !== 53) out.push({name, bytes: archive.subarray(at + 512, at + 512 + size)});
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

describe('validation 36: no Chinese in what the project delivers', function() {
  this.timeout(60000);
  let tracked = null;
  before(function() {
    // (a tree with no git, as the docker runner's image is, has nothing to
    // list. In a checkout, git failing is a failure, never a pass)
    if (!fs.existsSync(path.join(ROOT, '.git'))) return this.skip();
    const r = spawnSync('git', ['-c', 'core.quotepath=off', 'ls-files', '-z'], {cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});
    assert.strictEqual(r.status, 0, `git ls-files: ${r.error != null ? r.error.code : r.stderr}`);
    tracked = r.stdout.split('\0').filter((f) => f !== '');
    assert.ok(tracked.length > 500 && tracked.includes('package.json'), `the list of tracked files: ${tracked.length}`);
    return undefined;
  });

  it('no tracked file is named in it', () => {
    assert.deepStrictEqual(tracked.filter((f) => CHINESE.test(f)), []);
  });

  it('no tracked text file holds it', () => {
    const found = [];
    let read = 0;
    for (const f of tracked) {
      const file = path.join(ROOT, f);
      const st = fs.lstatSync(file, {throwIfNoEntry: false});
      if (st == null || !st.isFile()) continue;
      const bytes = fs.readFileSync(file);
      if (isBinary(bytes)) continue;
      read += 1;
      found.push(...hits(f, textOf(bytes)));
    }
    assert.ok(read > 500, `text files read: ${read}`);
    assert.deepStrictEqual(found.slice(0, MAX_SAID), [], `${found.length} lines`);
  });

  it('no text file inside a shipped package tarball holds it', () => {
    const tarballs = tracked.filter((f) => f.startsWith('pre-installed-packages/') && f.endsWith('.tgz'));
    assert.ok(tarballs.length > 0, 'the shipped tarballs');
    const found = [];
    for (const f of tarballs) {
      const files = tarFiles(zlib.gunzipSync(fs.readFileSync(path.join(ROOT, f))));
      assert.ok(files.length > 0, `${f}: its files`);
      for (const {name, bytes} of files) {
        assert.ok(!CHINESE.test(name), `${f}: ${name}`);
        if (!isBinary(bytes)) found.push(...hits(`${f}!${name}`, textOf(bytes)));
      }
    }
    assert.deepStrictEqual(found, []);
  });
});
