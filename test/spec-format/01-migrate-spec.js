// bin/countinghouse-migrate-spec.js: old spec format -> 5.0.0, and what the
// validator does with each. No server, no redis -- pure functions.
const assert    = require('assert');
const migrator  = require('../../bin/countinghouse-migrate-spec.js');
const validator = require('../../lib/validator');

function oldSpec() {
  return {
    configId: 1,
    specVersion: {major: 1, minor: 0},
    device: {
      friendlyName: 'fixture-device',
      manufacturer: 'countinghouse-test',
      modelDescription: 'a two-action module in the pre-5.0.0 format',
      serviceList: {
        'urn:countinghouse-test:serviceID:svc': {
          actionList: {
            first: {
              description: 'the first action',
              apiCache: 9000,
              apiLog: true,
              realPrice: 0.01,
              argumentList: {
                input:  {direction: 'in',  relatedStateVariable: 'A_ARG_TYPE_first_Input'},
                output: {direction: 'out', retval: true, relatedStateVariable: 'A_ARG_TYPE_first_Output'}
              },
              fault: {schema: '/fault/svc/first/fault'}
            },
            second: {
              description: 'the second action',
              argumentList: {
                input:  {direction: 'in',  relatedStateVariable: 'A_ARG_TYPE_second_Input'},
                output: {direction: 'out', relatedStateVariable: 'A_ARG_TYPE_second_Output'}
              }
            }
          },
          serviceStateTable: {
            A_ARG_TYPE_first_Input:   {dataType: 'object', sendEvents: false, schema: '/svc/first/input'},
            A_ARG_TYPE_first_Output:  {dataType: 'object', schema: '/svc/first/output'},
            A_ARG_TYPE_second_Input:  {dataType: 'object', schema: '/svc/second/input'},
            A_ARG_TYPE_second_Output: {dataType: 'object', schema: '/svc/second/output'}
          }
        }
      }
    }
  };
}

function expectedNewSpec() {
  return {
    device: {
      friendlyName: 'fixture-device',
      manufacturer: 'countinghouse-test',
      modelDescription: 'a two-action module in the pre-5.0.0 format',
      serviceList: {
        'urn:countinghouse-test:serviceID:svc': {
          actionList: [
            {
              name: 'first',
              description: 'the first action',
              input:  {schema: '/svc/first/input'},
              output: {schema: '/svc/first/output'},
              fault:  {schema: '/fault/svc/first/fault'}
            },
            {
              name: 'second',
              description: 'the second action',
              input:  {schema: '/svc/second/input'},
              output: {schema: '/svc/second/output'}
            }
          ]
        }
      }
    }
  };
}

describe('spec-format 01: the 5.0.0 migrator', () => {

  it('rewrites actions into an array carrying their own schema pointers', () => {
    assert.deepStrictEqual(migrator.migrate(oldSpec(), 'fixture'), expectedNewSpec());
  });

  it('keeps action order, so the tool order a module produces does not move', () => {
    const names = migrator.migrate(oldSpec(), 'fixture')
      .device.serviceList['urn:countinghouse-test:serviceID:svc'].actionList
      .map((a) => { return a.name; });
    assert.deepStrictEqual(names, ['first', 'second']);
  });

  it('is idempotent: re-running it over a converted spec changes nothing', () => {
    const once  = migrator.migrate(oldSpec(), 'fixture');
    const twice = migrator.migrate(JSON.parse(JSON.stringify(once)), 'fixture');
    assert.deepStrictEqual(twice, once);
  });

  it('recognizes both formats', () => {
    assert.strictEqual(migrator.isOldFormat(oldSpec()), true);
    assert.strictEqual(migrator.isOldFormat(expectedNewSpec()), false);
  });

  it('refuses to guess when an argument names a state variable that is not there', () => {
    const spec = oldSpec();
    delete spec.device.serviceList['urn:countinghouse-test:serviceID:svc']
      .serviceStateTable.A_ARG_TYPE_first_Input;

    assert.throws(() => { migrator.migrate(spec, 'fixture'); }, (e) => {
      return /A_ARG_TYPE_first_Input/.test(e.message) && /serviceStateTable/.test(e.message);
    });
  });

  it('refuses to guess when a state variable carries no schema pointer', () => {
    const spec = oldSpec();
    spec.device.serviceList['urn:countinghouse-test:serviceID:svc']
      .serviceStateTable.A_ARG_TYPE_first_Input = {dataType: 'string'};

    assert.throws(() => { migrator.migrate(spec, 'fixture'); }, (e) => {
      return /no schema pointer/.test(e.message);
    });
  });
});

describe('spec-format 02: what the validator accepts', () => {

  function validate(spec, cb) {
    validator.validateDeviceSpec(spec, (err) => { cb(err); });
  }

  it('accepts the migrated spec', (done) => {
    validate(migrator.migrate(oldSpec(), 'fixture'), (err) => {
      assert.strictEqual(err, null, err && err.message);
      done();
    });
  });

  it('rejects the old format with a message naming the converter, not an ajv symptom', (done) => {
    validate(oldSpec(), (err) => {
      assert.ok(err != null, 'an old-format spec must not validate');
      assert.ok(/pre-5\.0\.0 spec format/.test(err.message), err.message);
      assert.ok(/countinghouse-migrate-spec/.test(err.message), err.message);
      done();
    });
  });

  it('names serviceStateTable as the thing it saw, so the author can find it', (done) => {
    const spec = migrator.migrate(oldSpec(), 'fixture');
    spec.device.serviceList['urn:countinghouse-test:serviceID:svc'].serviceStateTable = {};

    validate(spec, (err) => {
      assert.ok(err != null);
      assert.ok(/serviceStateTable in service urn:countinghouse-test:serviceID:svc/.test(err.message), err.message);
      done();
    });
  });

  it('rejects two actions with the same name (an array cannot express uniqueness)', (done) => {
    const spec = migrator.migrate(oldSpec(), 'fixture');
    const list = spec.device.serviceList['urn:countinghouse-test:serviceID:svc'].actionList;
    list.push({name: 'first', description: 'a duplicate', input: {schema: '/svc/first/input'}});

    validate(spec, (err) => {
      assert.ok(err != null, 'a duplicate action name must not validate');
      assert.ok(/duplicate action name/.test(err.message), err.message);
      done();
    });
  });

  it('rejects an action that is missing its name', (done) => {
    const spec = migrator.migrate(oldSpec(), 'fixture');
    delete spec.device.serviceList['urn:countinghouse-test:serviceID:svc'].actionList[0].name;

    validate(spec, (err) => {
      assert.ok(err != null);
      assert.ok(/must have required property 'name'/.test(err.message), err.message);
      done();
    });
  });

  it('rejects a retired field rather than ignoring it', (done) => {
    const spec = migrator.migrate(oldSpec(), 'fixture');
    spec.device.serviceList['urn:countinghouse-test:serviceID:svc'].actionList[0].apiCache = 9000;

    validate(spec, (err) => {
      assert.ok(err != null, 'apiCache is gone in 5.0.0 and must be reported, not silently ignored');
      assert.ok(/must NOT have additional properties/.test(err.message), err.message);
      done();
    });
  });

  it('rejects an argument declared as anything other than a schema pointer', (done) => {
    const spec = migrator.migrate(oldSpec(), 'fixture');
    spec.device.serviceList['urn:countinghouse-test:serviceID:svc'].actionList[0].input =
      {type: 'object', properties: {}};

    validate(spec, (err) => {
      assert.ok(err != null, 'an inline schema is not the declared format');
      done();
    });
  });
});
