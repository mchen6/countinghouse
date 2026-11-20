'use strict';
// B-j1 (the high review of #463): a server's id is random, 16 hex
// characters, made at its first start and kept beside its data
// (<moduleDataPath>/.server-id; <storePath>/ in the single-identity
// profile), with the identity secret's checks (lib/private-file.js). Never
// derived from key material: rotating the identity secret leaves it. One
// directory, one id; separate directories, separate ids.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const serverId = require('../../lib/server-id');
const tmp = require('../helpers/test-tmp').forFile(['ch-auth-57-']);

const POSIX = process.platform !== 'win32';

describe('auth 57: the server id (B-j1)', () => {
  afterEach(() => serverId.reset());

  it('made once, 16 hex characters, mode 0600; the same directory reads the same id, another directory another', () => {
    const dir = tmp.mkdtemp('ch-auth-57-');
    serverId.initSync({moduleDataPath: dir});
    const id = serverId.get();
    assert.match(id, /^[0-9a-f]{16}$/);
    const file = path.join(dir, '.server-id');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), id);
    if (POSIX) assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
    serverId.reset();
    serverId.initSync({moduleDataPath: dir});
    assert.strictEqual(serverId.get(), id, 'a restart on the same directory');
    assert.strictEqual(serverId.read({moduleDataPath: dir}), id);
    const other = tmp.mkdtemp('ch-auth-57-');
    serverId.reset();
    serverId.initSync({moduleDataPath: other});
    assert.notStrictEqual(serverId.get(), id);
  });

  it('never derived from the identity secret: one rotated leaves the id as it was', () => {
    // (the secret's file written here, as the runtime writes it: no identity
    // state is left in this process for the next file)
    const dir = tmp.mkdtemp('ch-auth-57-');
    const secret = path.join(dir, '.identity-secret');
    fs.writeFileSync(secret, crypto.randomBytes(32).toString('hex'), {mode: 0o600});
    serverId.initSync({moduleDataPath: dir});
    const id = serverId.get();
    // the operator rotates the secret: a new one in its place
    fs.writeFileSync(secret, crypto.randomBytes(32).toString('hex'), {mode: 0o600});
    serverId.reset();
    serverId.initSync({moduleDataPath: dir});
    assert.strictEqual(serverId.get(), id);
  });

  it('in the single-identity profile it is kept in --storePath, as the secret is', () => {
    const base = tmp.mkdtemp('ch-auth-57-');
    const opts = {moduleDataPath: path.join(base, 'module_data'), storePath: path.join(base, 'store'), singleIdentity: true};
    serverId.initSync(opts);
    assert.strictEqual(fs.readFileSync(path.join(opts.storePath, '.server-id'), 'utf8'), serverId.get());
    assert.ok(!fs.existsSync(path.join(opts.moduleDataPath, '.server-id')));
  });

  it('refused, as the secret is: a link, a file others can reach, a file not in its form', function() {
    if (!POSIX) this.skip();   // (Windows: its ACL, auth 51's cases for the secret, by the same code)
    const refused = (dir, re) => {
      serverId.reset();
      assert.throws(() => serverId.initSync({moduleDataPath: dir}), (e) => e.code === 'SERVER_ID_INVALID' && re.test(e.message));
    };
    const linked = tmp.mkdtemp('ch-auth-57-');
    const real = path.join(linked, 'real');
    fs.writeFileSync(real, crypto.randomBytes(8).toString('hex'), {mode: 0o600});
    fs.symlinkSync(real, path.join(linked, '.server-id'));
    refused(linked, /is a symbolic link; the server id is never read through a link/);
    const open = tmp.mkdtemp('ch-auth-57-');
    fs.writeFileSync(path.join(open, '.server-id'), crypto.randomBytes(8).toString('hex'), {mode: 0o644});
    fs.chmodSync(path.join(open, '.server-id'), 0o644);
    refused(open, /accessible by group or others \(mode 644\); it must be 0600/);
    const bad = tmp.mkdtemp('ch-auth-57-');
    fs.writeFileSync(path.join(bad, '.server-id'), 'not-an-id', {mode: 0o600});
    refused(bad, /must hold the server id as 16 hex characters/);
  });

  tmp.hooks();
});
