// The tools/call path's per-call work (the latency breakdown of 2026-11-15,
// F3/F4/F5), server-free:
// - F3: the tool table (lib/mcp/tool-registry.js buildToolTargets) is built
//   once per change of its inputs -- every device's spec object, its listing
//   (role, listed) and the options -- not on every call. Any change of an
//   input rebuilds it: a spec replaced, a device gone or added, a module
//   unlisted or listed again. A table is frozen, so no caller can change
//   the shared copy.
// - F4: a tools/call's output schema is resolved once per action object
//   (a reload replaces the spec, and with it its action objects), never
//   cached from a failed resolution.
// - F5 (least privilege): a validator is sent the value it checks without
//   the framework's own keys (ctx, httpHeaders, jobID, usageCall, token):
//   it never validates them, so it never needs them. Every other key stays,
//   so an unknown argument is still refused.
const assert = require('assert');

const registry = require('../../lib/mcp/tool-registry');
const toolGeneration = require('../../lib/tool-generation');
const moduleSpec = require('../../lib/module-spec');
const validatorPool = require('../../lib/validator-pool');

const SERVICE = 'urn:countinghouse-test:serviceID:s';

function spec(name, actions) {
  return {device: {friendlyName: name, serviceList: {[SERVICE]: {actionList: actions.map((a) => ({name: a, description: `${a} it`, input: {schema: `/s/${a}/input`}, output: {schema: `/s/${a}/output`}}))}}}};
}

// a device manager of plain devices: deviceMap entries carry spec and
// packageInfo, as tool-registry reads them
function fakeInterface() {
  const deviceMap = {};
  const moduleManager = {unlisted: new Set()};
  return {
    deviceMap,
    moduleManager,
    cdif: {deviceManager: {
      deviceMap,
      moduleManager,
      getAllDeviceSpecs() {
        const out = {};
        for (const id in deviceMap) out[id] = deviceMap[id].spec;
        return out;
      }
    }}
  };
}

describe('module-loading 30: the tools/call path builds and fetches once per change', () => {
  describe('F3: the tool table', () => {
    it('is the same table while nothing changed, and frozen', () => {
      const f = fakeInterface();
      f.deviceMap.d1 = {spec: spec('one', ['a', 'b']), packageInfo: {name: 'one'}};
      const t1 = registry.buildToolTargets(f.cdif);
      const t2 = registry.buildToolTargets(f.cdif);
      assert.strictEqual(t1, t2, 'built again with nothing changed');
      assert.deepStrictEqual(Object.keys(t1).sort(), ['one_s_a', 'one_s_b']);
      assert.ok(Object.isFrozen(t1) && Object.isFrozen(t1.one_s_a), 'the shared table can be changed by a caller');
    });

    it('is rebuilt when a spec is replaced, a device goes or comes', () => {
      const f = fakeInterface();
      f.deviceMap.d1 = {spec: spec('one', ['a']), packageInfo: {name: 'one'}};
      const t1 = registry.buildToolTargets(f.cdif);
      f.deviceMap.d1 = {spec: spec('one', ['a', 'c']), packageInfo: {name: 'one'}};
      const t2 = registry.buildToolTargets(f.cdif);
      assert.notStrictEqual(t1, t2);
      assert.ok(t2.one_s_c != null, 'a reload\'s new action is missing');
      f.deviceMap.d2 = {spec: spec('two', ['x']), packageInfo: {name: 'two'}};
      assert.ok(registry.buildToolTargets(f.cdif).two_s_x != null, 'a new device is missing');
      delete f.deviceMap.d1;
      const t4 = registry.buildToolTargets(f.cdif);
      assert.strictEqual(t4.one_s_a, undefined, 'a gone device\'s tool is still there');
      assert.ok(t4.two_s_x != null);
    });

    it('follows a module unlisted and listed again, with and without includeUnlisted', () => {
      const f = fakeInterface();
      f.deviceMap.d1 = {spec: spec('one', ['a']), packageInfo: {name: 'one'}};
      assert.ok(registry.buildToolTargets(f.cdif).one_s_a != null);
      f.moduleManager.unlisted.add('one');
      assert.strictEqual(registry.buildToolTargets(f.cdif).one_s_a, undefined, 'an unlisted module is still listed');
      const all = registry.buildToolTargets(f.cdif, {includeUnlisted: true});
      assert.strictEqual(all.one_s_a.unlisted, true, 'includeUnlisted lost the unlisted mark');
      f.moduleManager.unlisted.delete('one');
      assert.ok(registry.buildToolTargets(f.cdif).one_s_a != null, 'listed again but still missing');
      assert.strictEqual(registry.buildToolTargets(f.cdif, {includeUnlisted: true}).one_s_a.unlisted, undefined);
    });

    it('is rebuilt after a spec changed in place, once the change is announced', () => {
      const f = fakeInterface();
      const s1 = spec('one', ['a']);
      f.deviceMap.d1 = {spec: s1, packageInfo: {name: 'one'}};
      assert.ok(registry.buildToolTargets(f.cdif).one_s_a != null);
      // CHDevice.updateDeviceSpec accepts the same object changed in place
      s1.device.serviceList[SERVICE].actionList.push({name: 'b', description: 'b it'});
      toolGeneration.bump();
      assert.ok(registry.buildToolTargets(f.cdif).one_s_b != null, 'an in-place update was missed');
    });

    it('is told of a change by updateDeviceSpec and by toolsetChanged', () => {
      const {CHDevice} = {CHDevice: require('../../lib/countinghouse-device')};
      const DeviceManager = require('../../lib/device-manager');
      const g0 = toolGeneration.current();
      DeviceManager.prototype.toolsetChanged.call({emit: () => {}});
      assert.ok(toolGeneration.current() > g0, 'toolsetChanged did not bump the generation');
      const g1 = toolGeneration.current();
      const api = require('../fixtures/input-required-probe/api.json');
      const fake = {initServices: () => {}};
      return new Promise((resolve) => {
        (CHDevice.prototype || CHDevice).updateDeviceSpec.call(fake, JSON.parse(JSON.stringify(api)));
        setImmediate(() => {
          assert.ok(toolGeneration.current() > g1, 'updateDeviceSpec did not bump the generation');
          resolve();
        });
      });
    });

    it('holds only global state: a per-key or per-session filter runs after it, on a copy', () => {
      const f = fakeInterface();
      f.deviceMap.d1 = {spec: spec('one', ['a']), packageInfo: {name: 'one'}};
      f.deviceMap.d2 = {spec: spec('two', ['b']), packageInfo: {name: 'two'}};
      const table = registry.buildToolTargets(f.cdif);
      // what tools/list does for a key that sees d1 only (tool-registry forCaller)
      const filtered = registry.forCaller(f.cdif, table, new Set(['d1']));
      assert.strictEqual(Reflect.deleteProperty(table, 'two_s_b'), false, 'a filter could cut the shared table down');
      assert.strictEqual(Reflect.set(table, 'x', 1), false);
      assert.deepStrictEqual(Object.keys(registry.buildToolTargets(f.cdif)).sort(), ['one_s_a', 'two_s_b'], 'the next caller lost a tool');
      assert.deepStrictEqual(Object.keys(filtered), ['one_s_a']);
    });

    it('keeps one interface\'s table apart from another\'s', () => {
      const f = fakeInterface();
      const g = fakeInterface();
      f.deviceMap.d1 = {spec: spec('one', ['a']), packageInfo: {name: 'one'}};
      g.deviceMap.d1 = {spec: spec('other', ['a']), packageInfo: {name: 'other'}};
      assert.ok(registry.buildToolTargets(f.cdif).one_s_a != null);
      assert.ok(registry.buildToolTargets(g.cdif).other_s_a != null);
      assert.ok(registry.buildToolTargets(f.cdif).one_s_a != null);
    });
  });

  describe('F4: a tools/call\'s output schema', () => {
    const target = (action) => ({deviceID: 'd1', serviceID: SERVICE, actionName: action.name, action});
    const resolver = (answers) => {
      const r = (cdif, appKey, t, cb) => { r.calls++; const a = answers.shift(); setImmediate(() => cb(a[0], a[1])); };
      r.calls = 0;
      return r;
    };

    it('is resolved once per action object', (done) => {
      const action = spec('one', ['a']).device.serviceList[SERVICE].actionList[0];
      const schema = {type: 'object', properties: {x: {type: 'string'}}};
      const r = resolver([[null, schema]]);
      registry.outputSchemaForCall(null, 'k', target(action), (e1, s1) => {
        registry.outputSchemaForCall(null, 'k', target(action), (e2, s2) => {
          assert.strictEqual(r.calls, 1, 'resolved again');
          assert.strictEqual(s1, schema);
          assert.strictEqual(s2, schema);
          // a reload gives new action objects: resolved afresh
          const reloaded = spec('one', ['a']).device.serviceList[SERVICE].actionList[0];
          const r2 = resolver([[null, null]]);
          registry.outputSchemaForCall(null, 'k', target(reloaded), (e3, s3) => {
            assert.strictEqual(r2.calls, 1);
            assert.strictEqual(s3, null);
            done();
          }, r2);
        }, r);
      }, r);
    });

    it('is resolved afresh after a change is announced', (done) => {
      const action = spec('one', ['a']).device.serviceList[SERVICE].actionList[0];
      const r = resolver([[null, {type: 'object'}], [null, null]]);
      registry.outputSchemaForCall(null, 'k', target(action), () => {
        toolGeneration.bump();
        registry.outputSchemaForCall(null, 'k', target(action), (e2, s2) => {
          assert.strictEqual(r.calls, 2, 'a schema from before the change was kept');
          assert.strictEqual(s2, null);
          done();
        }, r);
      }, r);
    });

    it('is never cached from a failed resolution, which answers as no schema', (done) => {
      const action = spec('one', ['a']).device.serviceList[SERVICE].actionList[0];
      const r = resolver([[{path: '/s/a/output', err: new Error('device restarting')}, null], [null, {type: 'object'}]]);
      const LOG = require('../../lib/logger');
      const realE = LOG.E;
      const logged = [];
      LOG.E = (e) => logged.push(e);
      try {
        registry.outputSchemaForCall(null, 'k', target(action), () => {}, resolver([[{path: '/s/a/output', err: new Error('x')}, null]]));
      } finally {
        LOG.E = realE;
      }
      LOG.E = (e) => logged.push(e);
      registry.outputSchemaForCall(null, 'k', target(action), (e1, s1) => {
        LOG.E = realE;
        assert.ok(logged.length >= 1, 'the downgrade was not logged');
        assert.strictEqual(e1, null);
        assert.strictEqual(s1, null, 'a failure is answered as no schema, as resolveOutputSchema does');
        registry.outputSchemaForCall(null, 'k', target(action), (e2, s2) => {
          assert.strictEqual(r.calls, 2, 'a failure was cached');
          assert.deepStrictEqual(s2, {type: 'object'});
          done();
        }, r);
      }, r);
    });
  });

  describe('F5: what a validator is sent', () => {
    it('leaves out the framework\'s own keys and keeps every other', () => {
      const args = {input: {timezone: 'UTC'}, usageCall: 3, ctx: {id: 'u_x', isAdmin: false}, token: 'a1b2', httpHeaders: {a: 'b'}, jobID: 'j', extra: 1};
      assert.deepStrictEqual(moduleSpec.validatorView(args), {input: {timezone: 'UTC'}, extra: 1});
      assert.ok('token' in args && 'ctx' in args, 'the call\'s own args were changed');
      assert.strictEqual(moduleSpec.validatorView(null), null);
      assert.deepStrictEqual(moduleSpec.validatorView([1, 2]), [1, 2]);
    });

    it('a value whose copy throws is refused, never sent with its framework keys', async () => {
      const real = validatorPool.pool;
      let sent = null;
      validatorPool.pool = () => ({check: (key, serviceID, actionName, which, value) => { sent = value; return Promise.resolve(null); }});
      // a getter that throws only once: a fallback to the full value would
      // send the token on the pool's own copy
      let reads = 0;
      const output = {token: 'the-call-token', ctx: {id: 'u_x'}};
      Object.defineProperty(output, 'output', {enumerable: true, get() { reads++; if (reads === 1) throw new Error('a module\'s getter'); return 1; }});
      let answer;
      try {
        answer = await moduleSpec.validate({key: 'm#1', serviceID: SERVICE, actionName: 'a'}, 'output', output);
      } finally {
        validatorPool.pool = real;
      }
      assert.strictEqual(sent, null, 'the value went to the pool');
      assert.ok(Array.isArray(answer) && answer[0] != null && answer[0].code === 'DEVICE_INVOKE_EXCEPTION', `not refused: ${JSON.stringify(answer)}`);
    });

    it('is what validate() hands the pool', async () => {
      const real = validatorPool.pool;
      let sent = null;
      validatorPool.pool = () => ({check: (key, serviceID, actionName, which, value) => { sent = value; return Promise.resolve(null); }});
      try {
        await moduleSpec.validate({key: 'm#1', serviceID: SERVICE, actionName: 'a'}, 'input', {input: {x: 1}, token: 't', ctx: {id: 'u'}, usageCall: 1});
      } finally {
        validatorPool.pool = real;
      }
      assert.deepStrictEqual(sent, {input: {x: 1}});
    });
  });
});
