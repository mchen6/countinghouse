// The runtime's own version said in one voice (R-version-bump's medium): a
// release bumps package.json, package-lock.json's two own fields and
// server.json's two (the MCP registry's manifest), and names its CHANGELOG
// section. publish.yml checks only the tag against package.json, so a file
// left behind would publish a manifest naming a version npm doesn't have.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const json = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));

describe('validation 37: the runtime\'s version agrees everywhere a release names it', () => {
  const version = json('package.json').version;

  it('is a strict MAJOR.MINOR.PATCH', () => {
    assert.ok(/^\d+\.\d+\.\d+$/.test(version), version);
  });

  it('package-lock.json\'s own two fields say it', () => {
    const lock = json('package-lock.json');
    assert.deepStrictEqual([lock.version, lock.packages[''].version], [version, version]);
  });

  it('server.json says it, and so does its package', () => {
    const server = json('server.json');
    assert.deepStrictEqual([server.version, server.packages.map((p) => p.version)], [version, server.packages.map(() => version)]);
  });

  // (between releases the newest section is "Unreleased"; a release commit
  // names it by the version, as 7.1.1's and 7.1.2's did)
  it('the CHANGELOG\'s newest section is "Unreleased" or this version', () => {
    const first = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8').split('\n').find((l) => l.startsWith('## '));
    assert.ok(first === '## Unreleased' || first === `## ${version}`, first);
  });
});
