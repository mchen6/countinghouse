'use strict';
// The identity secret on Windows, where every file reports mode 0666: its
// owner and ACL decide (lib/win-acl.js privateProblem), and a new secret is
// written with a DACL for the user and SYSTEM only. Before this, a second
// start on Windows refused its own secret ("accessible by group or others
// (mode 666)"). The rules are tested on every OS with ACLs as PowerShell
// gives them; the real reader and writer on Windows only.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync, execFileSync} = require('child_process');
const {privateProblem, fixHint} = require('../../lib/win-acl');

const ME = 'S-1-5-21-1-2-3-1001';
const OTHER = 'S-1-5-21-1-2-3-1002';
const USERS = 'S-1-5-32-545';
const EVERYONE = 'S-1-1-0';
const FULL = 2032127;
const READ = 1179785;   // FileSystemRights.Read | Synchronize

describe('auth 51: the identity secret on Windows: owner and ACL, not mode bits', function() {
  this.timeout(120000);

  it('the rules: this user, SYSTEM and Administrators only; anything unrecognised fails closed', () => {
    const acl = (owner, rules) => ({user: ME, owner: owner, otherAces: false, rules: rules});
    const own = [{sid: ME, rights: FULL, type: 'Allow'}, {sid: 'S-1-5-18', rights: FULL, type: 'Allow'}, {sid: 'S-1-5-32-544', rights: FULL, type: 'Allow'}];
    assert.strictEqual(privateProblem('s', acl(ME, own)), null, 'a profile directory\'s inherited rules');
    assert.strictEqual(privateProblem('s', acl('S-1-5-32-544', own)), null);
    assert.strictEqual(privateProblem('s', acl(ME, own[0])), null, 'one rule, as ConvertTo-Json gives it');
    assert.match(privateProblem('s', acl(OTHER, own)), /s is owned by S-1-5-21-1-2-3-1002, not this user, Administrators or SYSTEM/);
    assert.match(privateProblem('s', acl(ME, own.concat({sid: USERS, rights: READ, type: 'Allow'}))), /s is accessible by S-1-5-32-545/);
    assert.match(privateProblem('s', acl(ME, own.concat({sid: EVERYONE, rights: 0x1, type: 'Allow'}))), /accessible by S-1-1-0/, 'ReadData alone');
    assert.match(privateProblem('s', acl(ME, own.concat({sid: OTHER, rights: 0x2, type: 'Allow'}))), /accessible by/, 'WriteData alone');
    assert.strictEqual(privateProblem('s', acl(ME, own.concat({sid: EVERYONE, rights: 0x100000 | 0x20000 | 0x80, type: 'Allow'}))), null,
      'Synchronize, ReadPermissions, ReadAttributes read nothing of it');
    assert.strictEqual(privateProblem('s', acl(ME, own.concat({sid: EVERYONE, rights: FULL, type: 'Deny'}))), null, 'a deny takes away');
    assert.strictEqual(privateProblem('s', acl(ME, own.concat({sid: EVERYONE, rights: FULL, type: 'Allow', inheritOnly: true}))), null, 'for children only');
    assert.match(privateProblem('s', acl(ME, own.concat({sid: EVERYONE, rights: FULL, type: 'AllowCallback'}))), /access rule of type AllowCallback/);
    assert.match(privateProblem('s', acl(ME, own.concat({sid: EVERYONE, rights: 'many', type: 'Allow'}))), /could not be read/);
    assert.match(privateProblem('s', {owner: ME, rules: own}), /could not be read/, 'no current user');
    // a conditional rule (XA, ZA, XU), which GetAccessRules does not list, or no word on it
    assert.match(privateProblem('s', Object.assign(acl(ME, own), {otherAces: true})), /s has an access rule other than a plain allow or deny/);
    assert.match(privateProblem('s', {user: ME, owner: ME, rules: own}), /s has an access rule other than a plain allow or deny, or its rules could not all be read/);
    // the fix, by SID: nothing inherited, this user and SYSTEM, the others removed, the user the owner
    assert.strictEqual(fixHint('C:\\d\\.identity-secret', acl(OTHER, own.concat({sid: EVERYONE, rights: READ, type: 'Allow'}))),
      `icacls "C:\\d\\.identity-secret" /inheritance:r /grant:r *${ME}:F *S-1-5-18:F /remove *S-1-5-32-544 /remove *S-1-1-0\n  icacls "C:\\d\\.identity-secret" /setowner *${ME}`);
    assert.match(privateProblem('s', null), /could not be read/);
  });

  it('the PowerShell it runs names no cmdlet (a lookup rebuilds the module cache, and would load module code)', () => {
    const {FILE_ACL_SCRIPT, CREATE_SCRIPT} = require('../../lib/win-acl');
    for (const script of [FILE_ACL_SCRIPT, CREATE_SCRIPT]) {
      const code = script.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
      assert.doesNotMatch(code, /\b[A-Z][a-z]+-[A-Z][A-Za-z]+\b/, code);
    }
  });

  // A start's identity, in a process of its own: exit 0, or 2 with the refusal.
  const start = (dir, cwd) => spawnSync(process.execPath, ['-e', `
    try { require(${JSON.stringify(path.join(__dirname, '..', '..', 'lib', 'identity.js'))}).initSync({singleIdentity: true, storePath: process.argv[1]}); }
    catch (e) { process.stderr.write(e.message); process.exit(2); }`, dir], {encoding: 'utf8', cwd: cwd});

  (process.platform === 'win32' ? it : it.skip)('on Windows: a first start writes it for this user only, a second start reads it, a world-readable one is refused', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-idsec-'));
    try {
      const first = start(dir);
      assert.strictEqual(first.status, 0, first.stderr);
      const file = path.join(dir, '.identity-secret');
      const second = start(dir);
      assert.strictEqual(second.status, 0, `the second start: ${second.stderr}`);
      // what it was written with: no inheritance, the user and SYSTEM
      const acl = execFileSync('icacls', [file], {encoding: 'utf8'});
      assert.doesNotMatch(acl, /\(I\)/, `nothing inherited: ${acl}`);
      execFileSync('icacls', [file, '/grant', '*S-1-1-0:(R)'], {stdio: 'ignore'});
      const third = start(dir);
      assert.strictEqual(third.status, 2);
      assert.match(third.stderr, /is accessible by S-1-1-0; the identity secret must be readable by this user only; to make it so, run:\n  icacls ".*" \/inheritance:r \/grant:r \*S-1-5-21-[0-9-]+:F \*S-1-5-18:F .*\/remove \*S-1-1-0/);
    } finally {
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });

  (process.platform === 'win32' ? it : it.skip)('on Windows: created with its DACL in one call (only this user and SYSTEM, nothing inherited, no conditional rule); a name that exists is never written', () => {
    const {createPrivate, fileAcl} = require('../../lib/win-acl');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-idsec-'));
    try {
      const f = path.join(dir, 'x.tmp');
      createPrivate(f, 'a'.repeat(64));
      assert.strictEqual(fs.readFileSync(f, 'utf8'), 'a'.repeat(64));
      const acl = fileAcl(f);
      assert.strictEqual(acl.otherAces, false);
      const rules = Array.isArray(acl.rules) ? acl.rules : [acl.rules];
      assert.deepStrictEqual([...new Set(rules.map((r) => r.sid))].sort(), [acl.user, 'S-1-5-18'].sort(), JSON.stringify(acl));
      assert.doesNotMatch(execFileSync('icacls', [f], {encoding: 'utf8'}), /\(I\)/);
      // planted ahead: CreateNew refuses it, nothing is written into it
      const planted = path.join(dir, 'planted.tmp');
      fs.writeFileSync(planted, 'mine');
      assert.throws(() => createPrivate(planted, 'b'.repeat(64)));
      assert.strictEqual(fs.readFileSync(planted, 'utf8'), 'mine');
      // a relative store path (PowerShell runs in System32)
      fs.mkdirSync(path.join(dir, 'rel'));
      const rel = start('rel', dir);
      assert.strictEqual(rel.status, 0, rel.stderr);
      assert.strictEqual(start('rel', dir).status, 0);
    } finally {
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });

  (process.platform !== 'win32' ? it : it.skip)('elsewhere: the mode bits as before (a 0644 secret is refused)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-idsec-'));
    try {
      assert.strictEqual(start(dir).status, 0);
      assert.strictEqual(start(dir).status, 0);
      fs.chmodSync(path.join(dir, '.identity-secret'), 0o644);
      const r = start(dir);
      assert.strictEqual(r.status, 2);
      assert.match(r.stderr, /accessible by group or others \(mode 644\); it must be 0600/);
    } finally {
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });
});
