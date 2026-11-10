// S1: countinghouse-migrate-spec drops the retired device-level fields
// rateLimit and price, both while converting an old-format spec and from a
// spec already in the 5.0.0 format, so re-running it over a tree cleans them.
// No server, no redis.
const assert   = require('assert');
const fs       = require('fs');
const path     = require('path');
const migrator = require('../../bin/countinghouse-migrate-spec.js');
const {mkdtemp} = require('../helpers/test-tmp');

const newSpec = (extra) => ({device: Object.assign({friendlyName: 'd', manufacturer: 'm', modelDescription: 'x',
  serviceList: {'urn:t:serviceID:s': {actionList: [{name: 'a', input: {schema: '/s/a/input'}, output: {schema: '/s/a/output'}}]}}}, extra)});

describe('spec-format 02: the retired device fields rateLimit and price (S1)', () => {
  it('converting an old-format spec drops them', () => {
    const old = {configId: 1, specVersion: {major: 1, minor: 0}, device: {friendlyName: 'd', manufacturer: 'm', modelDescription: 'x',
      rateLimit: 5, price: '1 credit',
      serviceList: {'urn:t:serviceID:s': {actionList: {a: {argumentList: {input: {direction: 'in', relatedStateVariable: 'I'}}}},
        serviceStateTable: {I: {dataType: 'object', schema: '/s/a/input'}}}}}};
    const out = migrator.migrate(old);
    assert.strictEqual('rateLimit' in out.device, false);
    assert.strictEqual('price' in out.device, false);
    assert.strictEqual(out.device.friendlyName, 'd');
  });

  it('the CLI removes them from a spec already in the 5.0.0 format, and leaves a clean one unchanged', () => {
    const dir = mkdtemp('s1-migrate-');
    try {
      const dirty = path.join(dir, 'dirty.json');
      const clean = path.join(dir, 'clean.json');
      fs.writeFileSync(dirty, JSON.stringify(newSpec({rateLimit: 1, price: 'x'})));
      fs.writeFileSync(clean, JSON.stringify(newSpec({})));
      const before = fs.readFileSync(clean, 'utf8');
      assert.strictEqual(migrator.main([dirty, clean]), 0);
      const d = JSON.parse(fs.readFileSync(dirty, 'utf8')).device;
      assert.strictEqual('rateLimit' in d, false);
      assert.strictEqual('price' in d, false);
      assert.strictEqual(fs.readFileSync(clean, 'utf8'), before);
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  });
});
