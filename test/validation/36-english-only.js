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
// strokes, CJK punctuation, enclosed and compatibility symbols, vertical and
// small forms, and the fullwidth and halfwidth forms. In escapes:
// this file is one of those it reads.
const CHINESE = /[\p{Script=Han}\p{Script=Bopomofo}\u31c0-\u31ef\u3000-\u303f\u3200-\u33ff\ufe10-\ufe1f\ufe30-\ufe6f\uff00-\uffef]/u;
const MAX_SAID = 25;

// the text's lines holding such a character, as `name:line`
function hits(name, text) {
  if (!CHINESE.test(text)) return [];
  const out = [];
  text.split('\n').forEach((line, i) => { if (CHINESE.test(line)) out.push(`${name}:${i + 1}`); });
  return out;
}
// The binary types tracked here, by name: anything else is read as text, so
// a stray NUL or another encoding can't hide a file from this test.
const BINARY = new Set(['.gz', '.tgz', '.png']);
const isBinary = (name) => BINARY.has(path.extname(name).toLowerCase());
const isUtf16 = (bytes) => bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff));
// a text file's text: UTF-8, or UTF-16 by its byte order mark. Anything else
// (GBK, Big5, UTF-16 with no mark) is refused: it can't be checked
function textOf(name, bytes) {
  if (isUtf16(bytes)) return bytes[0] === 0xff ? bytes.toString('utf16le') : Buffer.from(bytes).swap16().toString('utf16le');
  assert.ok(!bytes.includes(0), `${name}: a NUL byte in a file of no known binary type`);
  try {
    return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  } catch (e) {
    return assert.fail(`${name}: not UTF-8`);
  }
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
      if (isBinary(f)) continue;
      read += 1;
      found.push(...hits(f, textOf(f, fs.readFileSync(file))));
    }
    assert.ok(read > 500, `text files read: ${read}`);
    assert.deepStrictEqual(found.slice(0, MAX_SAID), [], `${found.length} lines`);
  });

  it('no text file inside a shipped package tarball holds it', () => {
    const shipped = tracked.filter((f) => f.startsWith('pre-installed-packages/'));
    // (an archive of another kind would be read by nothing here)
    assert.deepStrictEqual(shipped.filter((f) => /\.(zip|tar|gz|bz2|xz|7z)$/i.test(f)), [], 'a shipped archive that is not a .tgz');
    const tarballs = shipped.filter((f) => f.endsWith('.tgz'));
    assert.ok(tarballs.length > 0, 'the shipped tarballs');
    const found = [];
    for (const f of tarballs) {
      const files = tarFiles(zlib.gunzipSync(fs.readFileSync(path.join(ROOT, f))));
      assert.ok(files.length > 0, `${f}: its files`);
      for (const {name, bytes} of files) {
        assert.ok(!CHINESE.test(name), `${f}: ${name}`);
        if (!isBinary(name)) found.push(...hits(`${f}!${name}`, textOf(`${f}!${name}`, bytes)));
      }
    }
    assert.deepStrictEqual(found, []);
  });
});
