// The operator's ceiling (part 3, section 4): trusted only when an ordinary
// user cannot have written it; a file that exists and fails any check fails
// closed. The POSIX and Windows rules are checked on every OS with a stand-in
// file system and ACL reader; on each OS the real reader runs once against a
// file this test may write (so not trusted). Server-free.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {readCeiling, aclProblem, parse, ceilingFile} = require('../../lib/settings-ceiling');

const ADMINS = 'S-1-5-32-544';
const SYSTEM = 'S-1-5-18';
const USERS = 'S-1-5-32-545';

// A stand-in file system: entries {path: {uid, mode, dir, link, text}}.
function fakeFs(entries, {real = {}} = {}) {
  const stat = (p) => {
    const e = entries[p];
    if (e == null) { const err = new Error(`ENOENT ${p}`); err.code = 'ENOENT'; throw err; }
    return {uid: e.uid, mode: e.mode, isFile: () => !e.dir && !e.link, isSymbolicLink: () => e.link === true};
  };
  const fds = new Map();
  return {
    lstatSync: stat,
    realpathSync: {native: (p) => real[p] || p},
    openSync: (p) => { const e = entries[p]; if (e == null || e.link) { const err = new Error('ELOOP'); err.code = e == null ? 'ENOENT' : 'ELOOP'; throw err; } fds.set(7, p); return 7; },
    fstatSync: (fd) => stat(fds.get(fd)),
    readFileSync: (p) => entries[typeof(p) === 'number' ? fds.get(p) : p].text,
    closeSync: () => {}
  };
}
const ROOTDIRS = {'/': {uid: 0, mode: 0o755, dir: true}, '/etc': {uid: 0, mode: 0o755, dir: true}, '/etc/countinghouse': {uid: 0, mode: 0o755, dir: true}};
const posix = (fileEntry, dirs = {}) => readCeiling({platform: 'linux', fs: fakeFs(Object.assign({}, ROOTDIRS, dirs, fileEntry == null ? {} : {'/etc/countinghouse/ceiling.json': fileEntry}))});
const GOOD = JSON.stringify({version: 1, maxOutputBytes: 16 * 1024 * 1024, forbid: ['autoUpgrade'], conversation: false});

describe('stdio 17: the operator\'s ceiling (part 3, section 4)', () => {
  it('the file: /etc/countinghouse/ceiling.json; %ProgramData%\\countinghouse\\ceiling.json on Windows', () => {
    assert.strictEqual(ceilingFile('linux'), '/etc/countinghouse/ceiling.json');
    assert.strictEqual(ceilingFile('darwin'), '/etc/countinghouse/ceiling.json');
    assert.strictEqual(ceilingFile('win32', 'D:\\PD'), 'D:\\PD\\countinghouse\\ceiling.json');
  });

  it('POSIX: no file is none; a root-owned file under root-owned directories is trusted and read', () => {
    assert.deepStrictEqual(posix(null), {state: 'none'});
    // no file, and its directory one an ordinary user made (who could remove the operator's file): fails closed
    assert.match(posix(null, {'/etc/countinghouse': {uid: 1000, mode: 0o755, dir: true}}).problem, /\/etc\/countinghouse is not owned by root/);
    assert.deepStrictEqual(readCeiling({platform: 'linux', fs: fakeFs({'/': ROOTDIRS['/'], '/etc': ROOTDIRS['/etc']})}), {state: 'none'}, 'no directory either');
    const r = posix({uid: 0, mode: 0o644, text: GOOD});
    assert.strictEqual(r.state, 'trusted');
    assert.deepStrictEqual(r.ceiling, {maxOutputBytes: 16 * 1024 * 1024, requestTimeout: undefined, forbid: ['autoUpgrade'], packs: null, conversation: false});
  });

  it('POSIX: untrusted, failing closed: a symlinked file, a user-owned or group-writable file, a user-writable parent', () => {
    assert.match(posix({uid: 0, mode: 0o644, link: true, text: GOOD}).problem, /symbolic link/);
    assert.match(posix({uid: 1000, mode: 0o644, text: GOOD}).problem, /not owned by root/);
    assert.match(posix({uid: 0, mode: 0o664, text: GOOD}).problem, /writable by group or others/);
    assert.match(posix({uid: 0, mode: 0o644, text: GOOD}, {'/etc/countinghouse': {uid: 1000, mode: 0o755, dir: true}}).problem, /\/etc\/countinghouse is not owned by root/);
    assert.match(posix({uid: 0, mode: 0o644, text: GOOD}, {'/etc': {uid: 0, mode: 0o777, dir: true}}).problem, /\/etc is writable/);
  });

  it('POSIX: the directory by its real path (macOS: /etc is /private/etc), checked all the way up', () => {
    const entries = {'/': ROOTDIRS['/'], '/private': {uid: 0, mode: 0o755, dir: true}, '/private/etc': {uid: 0, mode: 0o755, dir: true},
      '/private/etc/countinghouse': {uid: 0, mode: 0o755, dir: true}, '/private/etc/countinghouse/ceiling.json': {uid: 0, mode: 0o644, text: GOOD},
      '/etc/countinghouse/ceiling.json': {uid: 0, mode: 0o644, text: GOOD}};
    const ok = readCeiling({platform: 'darwin', fs: fakeFs(entries, {real: {'/etc/countinghouse': '/private/etc/countinghouse'}})});
    assert.strictEqual(ok.state, 'trusted');
    entries['/private'].mode = 0o777;
    assert.match(readCeiling({platform: 'darwin', fs: fakeFs(entries, {real: {'/etc/countinghouse': '/private/etc/countinghouse'}})}).problem, /\/private is writable/);
  });

  it('the content: only the keys a ceiling has, each of its type; anything else fails closed', () => {
    for (const [text, why] of [['{', /not JSON/], ['{"version": 2}', /version 1/], ['{"version": 1, "maxOutputBytes": -1}', /positive integer/],
      ['{"version": 1, "forbid": ["off"]}', /forbid may hold only/], ['{"version": 1, "forbid": ["packs"]}', /forbid may hold only moduleSandbox, autoUpgrade/],
      ['{"version": 1, "packs": "ci"}', /packs is not a list of pack names/], ['{"version": 1, "packs": ["Bad Name"]}', /packs is not a list/],
      ['{"version": 1, "requestTimeout": 500}', /requestTimeout is not a whole number of seconds/], ['{"version": 1, "requestTimeout": 1500}', /whole number of seconds/],
      ['{"version": 1, "conversation": "no"}', /true or false/], ['{"version": 1, "extra": 1}', /holds "extra"/]]) {
      assert.match(parse(text).problem, why, text);
      assert.match(posix({uid: 0, mode: 0o644, text}).problem, why);
    }
    assert.deepStrictEqual(parse('{"version": 1}').ceiling, {maxOutputBytes: undefined, requestTimeout: undefined, forbid: [], packs: null, conversation: true});
    assert.deepStrictEqual(parse('{"version": 1, "packs": [], "requestTimeout": 60000}').ceiling.packs, [], 'an empty allowlist: no pack loads');
  });

  it('Windows: owner and every write grant by well-known SID; anything else fails closed', () => {
    const win = (acl, entries = {}) => readCeiling({platform: 'win32', programData: 'C:\\ProgramData',
      fs: fakeFs(Object.assign({'C:\\ProgramData\\countinghouse': {dir: true}, 'C:\\ProgramData\\countinghouse\\ceiling.json': {text: GOOD}}, entries)), acl: () => acl});
    const ok = {owner: ADMINS, otherAces: false, rules: [{sid: ADMINS, rights: 2032127, type: 'Allow', inheritOnly: false}, {sid: SYSTEM, rights: 2032127, type: 'Allow', inheritOnly: false},
      {sid: USERS, rights: 1179817, type: 'Allow', inheritOnly: false}]};   // Users: ReadAndExecute
    assert.strictEqual(win({dir: ok, file: ok}).state, 'trusted');
    const usersWrite = {owner: ADMINS, otherAces: false, rules: ok.rules.concat([{sid: USERS, rights: 2, type: 'Allow', inheritOnly: false}])};
    assert.match(win({dir: usersWrite, file: ok}).problem, /its directory is writable by S-1-5-32-545/);
    assert.match(win({dir: ok, file: {owner: 'S-1-5-21-1-2-3-1001', otherAces: false, rules: ok.rules}}).problem, /the file is owned by S-1-5-21/);
    // an access rule other than a plain allow or deny (not wholly among the listed rules), or no word on one, fails closed
    assert.match(win({dir: ok, file: Object.assign({}, ok, {otherAces: true})}).problem, /the file has an access rule other than a plain allow or deny/);
    assert.match(win({dir: {owner: ADMINS, rules: ok.rules}, file: ok}).problem, /its directory has an access rule other than a plain allow or deny, or its rules could not all be read/);
    // an inherit-only grant does not apply to the object; a deny only restricts
    assert.strictEqual(win({dir: {owner: ADMINS, otherAces: false, rules: ok.rules.concat([{sid: USERS, rights: 2, type: 'Allow', inheritOnly: true}, {sid: USERS, rights: 2, type: 'Deny', inheritOnly: false}])}, file: ok}).state, 'trusted');
    assert.match(win(null).problem, /ACL could not be read/);
    assert.match(readCeiling({platform: 'win32', programData: 'C:\\ProgramData', fs: fakeFs({'C:\\ProgramData\\countinghouse': {dir: true}, 'C:\\ProgramData\\countinghouse\\ceiling.json': {text: GOOD}}),
      acl: () => { const e = new Error('spawn powershell.exe ENOENT'); e.code = 'ENOENT'; throw e; }}).problem, /ACL could not be read \(ENOENT\)/);
    assert.match(win({dir: ok, file: ok}, {'C:\\ProgramData\\countinghouse\\ceiling.json': {link: true}}).problem, /symbolic link/);
    assert.match(aclProblem('x', {owner: ADMINS, otherAces: false, rules: [{sid: USERS, rights: 'many', type: 'Allow'}]}), /could not be read/);
    // no file, in a directory a user owns: fails closed
    const userDir = {owner: 'S-1-5-21-1-2-3-1001', otherAces: false, rules: ok.rules};
    assert.match(readCeiling({platform: 'win32', programData: 'C:\\ProgramData', fs: fakeFs({'C:\\ProgramData\\countinghouse': {dir: true}}), acl: () => ({dir: userDir, file: userDir})}).problem,
      /its directory is owned by S-1-5-21-1-2-3-1001, not Administrators, SYSTEM or TrustedInstaller/);
  });

  it('Windows: the PowerShell it runs names no cmdlet (a lookup rebuilds the module cache, and would load module code)', () => {
    const {ACL_SCRIPT, PROGRAMDATA_SCRIPT} = require('../../lib/settings-ceiling');
    for (const script of [ACL_SCRIPT, PROGRAMDATA_SCRIPT]) {
      // a Verb-Noun outside quotes (the JSON's own text is quoted)
      const code = script.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
      assert.doesNotMatch(code, /\b[A-Z][a-z]+-[A-Z][A-Za-z]+\b/, code);
      assert.doesNotMatch(code, /\bImport-Module\b|\bGet-Acl\b|ConvertTo-Json/i);
    }
  });

  it('Windows: PowerShell is started from the Windows directory, which must be a drive path', () => {
    const {windowsDir} = require('../../lib/settings-ceiling');
    const saved = {SystemRoot: process.env.SystemRoot, windir: process.env.windir};
    try {
      process.env.SystemRoot = 'C:\\Windows\\';
      assert.strictEqual(windowsDir(), 'C:\\Windows');
      process.env.SystemRoot = '.\\here';
      assert.throws(() => windowsDir(), /SystemRoot is not a drive path/);
      delete process.env.SystemRoot; delete process.env.windir;
      assert.strictEqual(windowsDir(), 'C:\\Windows');
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });

  it('the real reader, on this OS: a file this test wrote is not trusted, and says why', function() {
    this.timeout(30000);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-ceiling-'));
    const file = path.join(dir, 'ceiling.json');
    fs.writeFileSync(file, GOOD);
    try {
      const r = readCeiling({file});
      if (process.getuid != null && process.getuid() === 0) return;   // root writes a root-owned file
      assert.strictEqual(r.state, 'untrusted', JSON.stringify(r));
      assert.match(r.problem, process.platform === 'win32' ? /owned by|writable by|ACL could not be read/ : /not owned by root|writable/);
      // no file in a directory this user made: untrusted (the user could remove an operator's file); no directory: none
      assert.strictEqual(readCeiling({file: path.join(dir, 'missing.json')}).state, 'untrusted');
      assert.deepStrictEqual(readCeiling({file: path.join(dir, 'nope', 'missing.json')}), {state: 'none'});
    } finally {
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });
});
