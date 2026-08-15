// bin/countinghouse-migrate-spec.js: old spec format -> 5.0.0, and what the
// validator does with each. No server, no redis -- pure functions.
var assert    = require('assert');
var migrator  = require('../../bin/countinghouse-migrate-spec.js');
var validator = require('../../lib/validator');

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

describe('spec-format 01: the 5.0.0 migrator', function() {

  it('rewrites actions into an array carrying their own schema pointers', function() {
    assert.deepStrictEqual(migrator.migrate(oldSpec(), 'fixture'), expectedNewSpec());
  });

  it('keeps action order, so the tool order a module produces does not move', function() {
    var names = migrator.migrate(oldSpec(), 'fixture')
      .device.serviceList['urn:countinghouse-test:serviceID:svc'].actionList
      .map(function(a) { return a.name; });
    assert.deepStrictEqual(names, ['first', 'second']);
  });

  it('is idempotent: re-running it over a converted spec changes nothing', function() {
    var once  = migrator.migrate(oldSpec(), 'fixture');
    var twice = migrator.migrate(JSON.parse(JSON.stringify(once)), 'fixture');
    assert.deepStrictEqual(twice, once);
  });

  it('recognizes both formats', function() {
    assert.strictEqual(migrator.isOldFormat(oldSpec()), true);
    assert.strictEqual(migrator.isOldFormat(expectedNewSpec()), false);
  });

  it('refuses to guess when an argument names a state variable that is not there', function() {
    var spec = oldSpec();
    delete spec.device.serviceList['urn:countinghouse-test:serviceID:svc']
      .serviceStateTable.A_ARG_TYPE_first_Input;

    assert.throws(function() { migrator.migrate(spec, 'fixture'); }, function(e) {
      return /A_ARG_TYPE_first_Input/.test(e.message) && /serviceStateTable/.test(e.message);
    });
  });

  it('refuses to guess when a state variable carries no schema pointer', function() {
    var spec = oldSpec();
    spec.device.serviceList['urn:countinghouse-test:serviceID:svc']
      .serviceStateTable.A_ARG_TYPE_first_Input = {dataType: 'string'};

    assert.throws(function() { migrator.migrate(spec, 'fixture'); }, function(e) {
      return /no schema pointer/.test(e.message);
    });
  });
});

describe('spec-format 02: what the validator accepts', function() {

  function validate(spec, cb) {
    validator.validateDeviceSpec(spec, function(err) { cb(err); });
  }

  it('accepts the migrated spec', function(done) {
    validate(migrator.migrate(oldSpec(), 'fixture'), function(err) {
      assert.strictEqual(err, null, err && err.message);
      done();
    });
  });

  it('rejects the old format with a message naming the converter, not an ajv symptom', function(done) {
    validate(oldSpec(), function(err) {
      assert.ok(err != null, 'an old-format spec must not validate');
      assert.ok(/pre-5\.0\.0 spec format/.test(err.message), err.message);
      assert.ok(/countinghouse-migrate-spec/.test(err.message), err.message);
      done();
    });
  });

  it('names serviceStateTable as the thing it saw, so the author can find it', function(done) {
    var spec = migrator.migrate(oldSpec(), 'fixture');
    spec.device.serviceList['urn:countinghouse-test:serviceID:svc'].serviceStateTable = {};

    validate(spec, function(err) {
      assert.ok(err != null);
      assert.ok(/serviceStateTable in service urn:countinghouse-test:serviceID:svc/.test(err.message), err.message);
      done();
    });
  });

  it('rejects two actions with the same name (an array cannot express uniqueness)', function(done) {
    var spec = migrator.migrate(oldSpec(), 'fixture');
    var list = spec.device.serviceList['urn:countinghouse-test:serviceID:svc'].actionList;
    list.push({name: 'first', description: 'a duplicate', input: {schema: '/svc/first/input'}});

    validate(spec, function(err) {
      assert.ok(err != null, 'a duplicate action name must not validate');
      assert.ok(/duplicate action name/.test(err.message), err.message);
      done();
    });
  });

  it('rejects an action that is missing its name', function(done) {
    var spec = migrator.migrate(oldSpec(), 'fixture');
    delete spec.device.serviceList['urn:countinghouse-test:serviceID:svc'].actionList[0].name;

    validate(spec, function(err) {
      assert.ok(err != null);
      assert.ok(/must have required property 'name'/.test(err.message), err.message);
      done();
    });
  });

  it('rejects a retired field rather than ignoring it', function(done) {
    var spec = migrator.migrate(oldSpec(), 'fixture');
    spec.device.serviceList['urn:countinghouse-test:serviceID:svc'].actionList[0].apiCache = 9000;

    validate(spec, function(err) {
      assert.ok(err != null, 'apiCache is gone in 5.0.0 and must be reported, not silently ignored');
      assert.ok(/must NOT have additional properties/.test(err.message), err.message);
      done();
    });
  });

  it('rejects an argument declared as anything other than a schema pointer', function(done) {
    var spec = migrator.migrate(oldSpec(), 'fixture');
    spec.device.serviceList['urn:countinghouse-test:serviceID:svc'].actionList[0].input =
      {type: 'object', properties: {}};

    validate(spec, function(err) {
      assert.ok(err != null, 'an inline schema is not the declared format');
      done();
    });
  });
});
