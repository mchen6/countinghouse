// The settings ceiling's ProgramData, found by a runtime with no SystemDrive
// in its environment (Windows only). ch-local's shim starts its daemon, and
// so the runtime, with a cleared environment that holds none; libuv completes
// a child's SYSTEMDRIVE only from its parent's own, so PowerShell had none
// either, and the known folder (ProfileList's %SystemDrive%\ProgramData)
// came back empty: every loosening was refused SETTING_CEILING_UNTRUSTED
// (ch-local's Windows acceptance). The lookup sets SystemDrive itself, from
// the system's own Windows directory, never from the runtime's environment.
const assert = require('assert');
const path = require('path');
const {spawnSync} = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
// what the lookup gives in a runtime whose environment has no SystemDrive
// (argv[1]: a SystemDrive to set instead, a wrong one the lookup must not use)
const CHILD = `
  if (process.argv[1] != null) process.env.SystemDrive = process.argv[1]; else delete process.env.SystemDrive;
  const ceiling = require(${JSON.stringify(path.join(ROOT, 'lib', 'settings-ceiling'))});
  let file;
  try { file = ceiling.ceilingFile(); } catch (e) { file = 'THROWS ' + e.message; }
  console.log(JSON.stringify({systemDrive: process.env.SystemDrive == null ? null : process.env.SystemDrive, file}));
`;

describe('stdio 34: the ceiling\'s ProgramData with no SystemDrive in the runtime\'s environment', function() {
  this.timeout(60000);
  before(function() { if (process.platform !== 'win32') this.skip(); });

  it('is the system\'s ProgramData, as with SystemDrive', () => {
    const expected = require('../../lib/settings-ceiling').ceilingFile();
    const r = spawnSync(process.execPath, ['-e', CHILD], {encoding: 'utf8', timeout: 45000});
    assert.strictEqual(r.status, 0, `${r.stdout} ${r.stderr}`);
    const got = JSON.parse(String(r.stdout).trim());
    assert.strictEqual(got.systemDrive, null, 'the runtime had no SystemDrive');
    assert.match(got.file, /^[A-Za-z]:\\.*\\countinghouse\\ceiling\.json$/i, JSON.stringify(got));
    assert.strictEqual(got.file.toLowerCase(), expected.toLowerCase(), JSON.stringify(got));
  });

  // never the runtime's: a SystemDrive pointed elsewhere would have moved
  // the ceiling to where a user can write
  it('is the system\'s ProgramData with a wrong SystemDrive in the runtime\'s environment too', () => {
    const expected = require('../../lib/settings-ceiling').ceilingFile();
    const r = spawnSync(process.execPath, ['-e', CHILD, 'Z:'], {encoding: 'utf8', timeout: 45000});
    assert.strictEqual(r.status, 0, `${r.stdout} ${r.stderr}`);
    const got = JSON.parse(String(r.stdout).trim());
    assert.strictEqual(got.systemDrive, 'Z:', 'the runtime had SystemDrive Z:');
    assert.strictEqual(got.file.toLowerCase(), expected.toLowerCase(), JSON.stringify(got));
  });
});
