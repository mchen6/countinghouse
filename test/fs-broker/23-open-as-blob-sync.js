// Node 26 adds fs.openAsBlobSync. Without a broker route it was a way for
// module code to read any file under every --moduleSandbox mode on Node 26.
// It is brokered like openAsBlob, and installed only where Node has it.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {runBrokered} = require('../helpers/brokered-worker');

describe('fs-broker 23: fs.openAsBlobSync is brokered (Node 26)', function() {
  this.timeout(30000);

  it('under enforce: an inside path gives a Blob with the file\'s bytes; an outside path is ENOENT', async function() {
    if (typeof(fs.openAsBlobSync) !== 'function') this.skip();   // Node 24 has no such method
    const m = await runBrokered(path.join(__dirname, 'scripts', 'open-as-blob-sync.js'), {mode: 'enforce', files: {'f.txt': 'brokered bytes'}});
    assert.strictEqual(m.ok, true, JSON.stringify(m));
    assert.deepStrictEqual(m.r, {present: true, inside: {text: 'brokered bytes', type: 'text/plain', isBlob: true}, outside: 'ENOENT'});
  });

  it('where Node has no openAsBlobSync, the patch adds none', async function() {
    if (typeof(fs.openAsBlobSync) === 'function') this.skip();
    const m = await runBrokered(path.join(__dirname, 'scripts', 'open-as-blob-sync.js'), {mode: 'enforce'});
    assert.strictEqual(m.ok, true, JSON.stringify(m));
    assert.deepStrictEqual(m.r, {present: false});
  });
});
