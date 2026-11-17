// A validator-pool request refused while still queued says the time it
// actually waited: its queue bound, never the compile budget it never
// reached. #327's review: a load's prompts request queued on a pool with no
// validators (a closed pool left shared) waited out LOAD_QUEUE_MAX_MS (30 s)
// and was refused "not validated within 10000 ms", which read as a slow
// compile and misled the diagnosis. Small on purpose: one pool of one
// validator (and its spare), no stalls; the slots are held unservable, so
// the request is known to stay queued.
const assert = require('assert');

const SERVICE = 'urn:countinghouse-test:serviceID:s';

describe('module-loading 35: a request refused in the queue names its queue wait', function() {
  this.timeout(30000);
  let ValidatorPool = null;
  const LOG = require('../../lib/logger');
  let logE = null;
  const errors = [];
  before(() => {
    require('../../lib/cli-options').setOptions({workerThread: true});
    ({ValidatorPool} = require('../../lib/validator-pool'));
    logE = LOG.E;
    LOG.E = (e) => { errors.push(String(e && e.message)); return e; };
  });
  after(() => {
    LOG.E = logE;
    require('../../lib/cli-options').setOptions({workerThread: false});
  });

  // a pool whose validators never take a request: it stays queued
  function stuckPool(opts) {
    const p = new ValidatorPool(Object.assign({size: 1, timeoutMs: 300, compileMs: 2000}, opts));
    p.servable = () => false;
    return p;
  }
  function register(p, name) {
    const api = {device: {friendlyName: name, serviceList: {[SERVICE]: {actionList: [{name: 'a', input: {schema: '/s/a/input'}}]}}}};
    const key = `${name}#1`;
    p.register(key, name, JSON.stringify(api), JSON.stringify({$id: '#/', s: {a: {input: {type: 'object'}}}}));
    return key;
  }

  it('a load\'s request (warm) refused in the queue: within its queue wait (loadQueueMs), not the compile budget', async () => {
    const p = stuckPool({loadQueueMs: 150});
    try {
      const key = register(p, 'qwait-warm');
      const started = Date.now();
      const answer = await p.warm(key);
      assert.ok(answer != null && answer.timeout != null, JSON.stringify(answer));
      assert.strictEqual(answer.timeout.code, 'VALIDATION_TIMEOUT');
      assert.match(answer.timeout.message, /within 150 ms/, answer.timeout.message);
      assert.ok(!/2000 ms/.test(answer.timeout.message), 'never the compile budget');
      assert.ok(Date.now() - started < 2000, 'refused at its queue bound');
      assert.ok(errors.some((e) => /within 150 ms \(its wait in the queue\)/.test(e)), errors.join('\n'));
    } finally {
      p.close();
    }
  });

  it('a load\'s other request (prompts) refused in the queue: the same', async () => {
    const p = stuckPool({loadQueueMs: 150});
    try {
      const key = register(p, 'qwait-prompts');
      const answer = await p.prompts(key);
      assert.ok(answer != null && answer.timeout != null, JSON.stringify(answer));
      assert.match(answer.timeout.message, /within 150 ms/, answer.timeout.message);
    } finally {
      p.close();
    }
  });

  it('a call\'s check refused in the queue still says its own deadline, as before', async () => {
    const p = stuckPool({loadQueueMs: 150});
    try {
      const key = register(p, 'qwait-check');
      const answer = await p.check(key, SERVICE, 'a', 'input', {input: {}}, 'u_q');
      assert.ok(Array.isArray(answer), JSON.stringify(answer));
      assert.strictEqual(answer[0].code, 'VALIDATION_TIMEOUT');
      assert.match(answer[0].message, /within 300 ms/, answer[0].message);
    } finally {
      p.close();
    }
  });
});
