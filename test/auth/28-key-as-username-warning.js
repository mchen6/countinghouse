// The file auth provider warns at startup about an entry whose API key doubles
// as its user name -- user names are shown to callers (bills, check_balance),
// so such a key is handed to everyone -- and about an entry with no userName,
// whose key the provider would use as the user name. The warning names the
// entry by position and never prints a key.
const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const LOG    = require('../../lib/logger');
const FileAuthProvider = require('../../lib/auth/file-provider');

describe('auth 28: the file provider warns when a key doubles as a user name', () => {
  let tmp, warnings, originalW;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-auth-28-'));
    warnings = [];
    originalW = LOG.W;
    LOG.W = (msg) => { warnings.push(String(msg)); return msg; };
  });

  afterEach(() => {
    LOG.W = originalW;
    fs.rmSync(tmp, {recursive: true, force: true});
  });

  function load(config) {
    const file = path.join(tmp, 'auth.json');
    fs.writeFileSync(file, JSON.stringify(config));
    return new FileAuthProvider({configPath: file});
  }

  const ours = () => warnings.filter((w) => w.startsWith('FileAuthProvider:'));

  it('warns once for a key equal to its userName, by position, without printing it', () => {
    load({'k-ok-28': {userName: 'ok', devices: []}, 'k-same-28': {userName: 'k-same-28', devices: []}});
    assert.strictEqual(ours().length, 1, JSON.stringify(warnings));
    assert.ok(ours()[0].includes('entry #2'), ours()[0]);
    assert.ok(/shown to callers/.test(ours()[0]), ours()[0]);
    assert.ok(!warnings.some((w) => w.includes('k-same-28') || w.includes('k-ok-28')), JSON.stringify(warnings));
  });

  it('warns for an entry without userName by position, without printing its key', () => {
    load({'k-first-28': {userName: 'first', devices: []}, 'k-secret-28': {devices: []}});
    assert.strictEqual(ours().length, 1, JSON.stringify(warnings));
    assert.ok(ours()[0].includes('entry #2'), ours()[0]);
    assert.ok(!warnings.some((w) => w.includes('k-secret-28')), JSON.stringify(warnings));
  });

  it('stays quiet for a clean config', () => {
    load({k1: {userName: 'a', devices: []}});
    assert.deepStrictEqual(ours(), []);
  });
});
