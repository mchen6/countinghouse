// Unit-level cover for the strict bidirectional check in lib/handler-map.js
// (design section 3.4). Convention-based assembly makes silent mismatches easy
// to produce, and "a module with an illegal spec just disappears" is a defect
// class this repo has already fixed once -- see
// test/module-loading/03-legacy-spec-not-silent.js. It must not come back
// through the handler-map door.
//
// These run in-process against the pure functions, so they are fast and can
// assert on exact message content. 05-handler-map-assembly.js covers the same
// ground end to end through a real server.
const assert = require('assert');
const path   = require('path');

const handlerMap = require('../../lib/handler-map');

function specWith(services) {
  return {device: {friendlyName: 'fixture', serviceList: services}};
}

const GREET = 'urn:countinghouse-test:serviceID:greetService';

function greetSpec(actionNames) {
  return specWith({
    [GREET]: {actionList: actionNames.map((n) => ({name: n}))}
  });
}

const noop = () => {};

describe('handler-map: short name resolution', () => {
  it('takes the segment after :serviceID:, including non-ASCII names', () => {
    assert.strictEqual(handlerMap.shortNameOf(GREET), 'greetService');
    assert.strictEqual(handlerMap.shortNameOf('urn:example-com:serviceID:服务名称'), '服务名称');
  });

  it('returns null for a URN with no :serviceID: segment', () => {
    assert.strictEqual(handlerMap.shortNameOf('urn:example-com:whatever'), null);
  });
});

describe('handler-map: shape detection', () => {
  it('accepts a plain {service: {action: fn}} object', () => {
    assert.strictEqual(handlerMap.isHandlerMap({greetService: {hello: noop}}), true);
  });

  it('rejects a constructor, so the legacy discovery path still wins', () => {
    function Device() {}
    Device.prototype.hello = noop;
    assert.strictEqual(handlerMap.isHandlerMap(Device), false);
  });

  it('rejects a class instance (an EventEmitter subclass is not a bare object)', () => {
    const events = require('events');
    assert.strictEqual(handlerMap.isHandlerMap(new events.EventEmitter()), false);
  });

  it('rejects an empty object and a nested non-function', () => {
    assert.strictEqual(handlerMap.isHandlerMap({}), false);
    assert.strictEqual(handlerMap.isHandlerMap({greetService: {hello: 'not a function'}}), false);
  });
});

describe('handler-map: strict bidirectional validation', () => {
  it('passes when api.json and the handler map line up exactly', () => {
    const problems = handlerMap.validateHandlerMap(
      greetSpec(['hello']), {greetService: {hello: noop}}, 'fixture');
    assert.deepStrictEqual(problems, []);
  });

  it('a declared action with no handler is reported, naming module/service/action', () => {
    const problems = handlerMap.validateHandlerMap(
      greetSpec(['hello']), {greetService: {}}, 'fixture');

    assert.strictEqual(problems.length, 1, problems.join('\n'));
    const p = problems[0];
    assert.ok(p.indexOf('fixture') !== -1,               `names the module: ${p}`);
    assert.ok(p.indexOf('stage=assembleHandlerMap') !== -1, `names the stage: ${p}`);
    assert.ok(p.indexOf('greetService.hello') !== -1,    `names the action: ${p}`);
    assert.ok(/add it|remove the/i.test(p),              `offers a way out: ${p}`);
  });

  it('a handler with no declaration is reported (the typo shape)', () => {
    const problems = handlerMap.validateHandlerMap(
      greetSpec(['hello']), {greetService: {hello: noop, goodbye: noop}}, 'fixture');

    assert.strictEqual(problems.length, 1, problems.join('\n'));
    const p = problems[0];
    assert.ok(p.indexOf('greetService.goodbye') !== -1, `names the extra action: ${p}`);
    assert.ok(p.indexOf('hello') !== -1,                `lists what is declared: ${p}`);
    assert.ok(/typo|add the/i.test(p),                  `offers a way out: ${p}`);
  });

  it('an unresolvable service short name is reported, listing the known ones', () => {
    const problems = handlerMap.validateHandlerMap(
      greetSpec(['hello']), {greetingService: {hello: noop}}, 'fixture');

    // one for the unknown key, one for greetService having no handlers at all
    const unknown = problems.filter((p) => p.indexOf('"greetingService"') !== -1);
    assert.strictEqual(unknown.length, 1, problems.join('\n'));
    assert.ok(unknown[0].indexOf('greetService') !== -1,
      `lists the services that do exist: ${unknown[0]}`);
    assert.ok(unknown[0].indexOf('short name') !== -1,
      `explains short-name-not-URN: ${unknown[0]}`);
  });

  it('an ambiguous short name is reported as ambiguous, not silently resolved', () => {
    const spec = specWith({
      'urn:a-com:serviceID:dup': {actionList: [{name: 'hello'}]},
      'urn:b-com:serviceID:dup': {actionList: [{name: 'hello'}]}
    });
    const problems = handlerMap.validateHandlerMap(spec, {dup: {hello: noop}}, 'fixture');

    const ambiguous = problems.filter((p) => p.indexOf('ambiguous') !== -1);
    assert.strictEqual(ambiguous.length, 1, problems.join('\n'));
    assert.ok(ambiguous[0].indexOf('urn:a-com:serviceID:dup') !== -1, ambiguous[0]);
    assert.ok(ambiguous[0].indexOf('urn:b-com:serviceID:dup') !== -1, ambiguous[0]);
  });

  it('reports every problem at once rather than stopping at the first', () => {
    const spec = greetSpec(['hello', 'goodbye']);
    const problems = handlerMap.validateHandlerMap(
      spec, {greetService: {typo: noop}}, 'fixture');

    // 1 undeclared handler (typo) + 2 declared actions with no handler
    assert.strictEqual(problems.length, 3, problems.join('\n'));
  });

  it('a non-handler-map export is rejected with a shape message', () => {
    const problems = handlerMap.validateHandlerMap(greetSpec(['hello']), {}, 'fixture');
    assert.strictEqual(problems.length, 1);
    assert.ok(problems[0].indexOf('does not export a handler map') !== -1, problems[0]);
  });
});

describe('handler-map: convention assembly', () => {
  const root = path.join(__dirname, '..', 'fixtures');

  it('builds the map from handlers/<service>/<action>.js', () => {
    const map = handlerMap.loadConventionHandlers(
      path.join(root, 'handler-map-convention'), require);

    assert.ok(map != null, 'found a handlers/ directory');
    assert.deepStrictEqual(Object.keys(map), ['greetService']);
    assert.deepStrictEqual(Object.keys(map.greetService), ['hello']);
    assert.strictEqual(typeof map.greetService.hello, 'function');
  });

  it('returns null when there is no handlers/ directory', () => {
    assert.strictEqual(
      handlerMap.loadConventionHandlers(path.join(root, 'handler-map-module'), require), null);
  });

  it('the assembled convention map validates against its own api.json', () => {
    const modulePath = path.join(root, 'handler-map-convention');
    const spec = JSON.parse(require('fs').readFileSync(path.join(modulePath, 'api.json')).toString());
    const map  = handlerMap.loadConventionHandlers(modulePath, require);

    assert.deepStrictEqual(handlerMap.validateHandlerMap(spec, map, 'handler-map-convention'), []);
  });
});
