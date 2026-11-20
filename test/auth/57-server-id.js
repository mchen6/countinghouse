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

  it('two starts making it at once keep one file: the one that lost takes the winner\'s id, and leaves no temporary file', () => {
    const privateFile = require('../../lib/private-file');
    const dir = tmp.mkdtemp('ch-auth-57-');
    const opts = {moduleDataPath: dir};
    // the winner's file lands between this start's read (none) and its write
    const winner = crypto.randomBytes(8).toString('hex');
    const real = privateFile.createPrivate;
    privateFile.createPrivate = (d, file, content, spec, flag) => {
      privateFile.createPrivate = real;
      fs.writeFileSync(file, winner, {mode: 0o600});
      return real(d, file, content, spec, flag);
    };
    try {
      serverId.initSync(opts);
    } finally {
      privateFile.createPrivate = real;
    }
    assert.strictEqual(serverId.get(), winner);
    assert.strictEqual(fs.readFileSync(path.join(dir, '.server-id'), 'utf8'), winner);
    assert.deepStrictEqual(fs.readdirSync(dir), ['.server-id']);
  });

  it('a file with a second name (a hard link) is refused: one name only', function() {
    if (!POSIX) this.skip();
    const dir = tmp.mkdtemp('ch-auth-57-');
    fs.writeFileSync(path.join(dir, '.server-id'), crypto.randomBytes(8).toString('hex'), {mode: 0o600});
    fs.linkSync(path.join(dir, '.server-id'), path.join(dir, 'alias'));
    assert.throws(() => serverId.initSync({moduleDataPath: dir}), (e) => e.code === 'SERVER_ID_INVALID' && /has 2 names \(hard links\)/.test(e.message));
  });

  it('a publish cut short (its temporary name left as a second name of the file) does not stop the next start: the stray name is removed', function() {
    if (!POSIX) this.skip();
    const dir = tmp.mkdtemp('ch-auth-57-');
    const file = path.join(dir, '.server-id');
    const id = crypto.randomBytes(8).toString('hex');
    fs.writeFileSync(file, id, {mode: 0o600});
    fs.linkSync(file, `${file}.4242.tmp`);
    serverId.initSync({moduleDataPath: dir});
    assert.strictEqual(serverId.get(), id);
    assert.deepStrictEqual(fs.readdirSync(dir), ['.server-id']);
    assert.strictEqual(fs.statSync(file).nlink, 1);
  });

  it('a start that lost the race waits for the winner to finish publishing (its temporary name still there), then takes its id', function() {
    if (!POSIX) this.skip();
    const privateFile = require('../../lib/private-file');
    const dir = tmp.mkdtemp('ch-auth-57-');
    const file = path.join(dir, '.server-id');
    const winner = crypto.randomBytes(8).toString('hex');
    const theirTmp = `${file}.999999.tmp`;
    const real = privateFile.createPrivate;
    privateFile.createPrivate = () => {
      // the winner has linked its file and not yet removed its temporary name;
      // it does so a moment later, in a process of its own
      fs.writeFileSync(theirTmp, winner, {mode: 0o600});
      fs.linkSync(theirTmp, file);
      require('child_process').spawn(process.execPath, ['-e', `setTimeout(() => require('fs').unlinkSync(${JSON.stringify(theirTmp)}), 150)`], {stdio: 'ignore'});
      return false;
    };
    try {
      serverId.initSync({moduleDataPath: dir});
    } finally {
      privateFile.createPrivate = real;
    }
    assert.strictEqual(serverId.get(), winner);
  });

  it('on a file system without hard links it is made by an exclusive create, never over a file there', () => {
    const privateFile = require('../../lib/private-file');
    const spec = {what: 'the test file', form: /^[0-9a-f]{16}$/, formText: '16 hex characters', variable: 'X', refuse: (m) => new Error(m)};
    const dir = tmp.mkdtemp('ch-auth-57-');
    const file = path.join(dir, '.server-id');
    const realLink = fs.linkSync;
    fs.linkSync = () => { throw Object.assign(new Error('no links here'), {code: 'ENOTSUP'}); };
    try {
      assert.strictEqual(privateFile.createPrivate(dir, file, 'aaaaaaaaaaaaaaaa', spec, '--moduleDataPath'), true);
      assert.strictEqual(privateFile.createPrivate(dir, file, 'bbbbbbbbbbbbbbbb', spec, '--moduleDataPath'), false);
    } finally {
      fs.linkSync = realLink;
    }
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'aaaaaaaaaaaaaaaa');
    assert.deepStrictEqual(fs.readdirSync(dir), ['.server-id']);
    if (POSIX) assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  });

  it('a temporary name that cannot be removed once the file is published is logged with its path, never the start\'s end', () => {
    const privateFile = require('../../lib/private-file');
    const LOG = require('../../lib/logger');
    const spec = {what: 'the test file', form: /^[0-9a-f]{16}$/, formText: '16 hex characters', variable: 'X', refuse: (m) => new Error(m)};
    const dir = tmp.mkdtemp('ch-auth-57-');
    const file = path.join(dir, '.server-id');
    const said = [];
    const saved = LOG.W;
    const realUnlink = fs.unlinkSync;
    LOG.W = (m) => said.push(String(m));
    fs.unlinkSync = (p) => { if (String(p).endsWith('.tmp')) throw Object.assign(new Error('busy'), {code: 'EBUSY'}); return realUnlink(p); };
    try {
      assert.strictEqual(privateFile.createPrivate(dir, file, 'cccccccccccccccc', spec, '--moduleDataPath'), true);
    } finally {
      fs.unlinkSync = realUnlink;
      LOG.W = saved;
    }
    const tmpName = `${file}.${process.pid}.tmp`;
    assert.ok(said.some((m) => m.includes(tmpName) && /second name of the file published beside it/.test(m)), JSON.stringify(said));
    fs.unlinkSync(tmpName);
  });

  tmp.hooks();
});
