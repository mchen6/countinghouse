'use strict';
// B-j1: each runtime's job queue is its own. The BullMQ prefix was
// '{cdifJob}' for every runtime, so two runtimes on one Redis took each
// other's jobs: a job for a module only one of them loaded ran on the
// other and failed. Now it is named by the server's own id, random and kept
// beside its data (lib/server-id.js; lib/job-control-common.js
// jobQueuePrefix). Two runtimes on one (private) Redis, each with its own
// module data directory and a module the other does not have: every job
// each is given completes, in its own queue. Jobs left under the old shared
// prefix, and history under the old unscoped keys, are not moved: each start
// says so once, read-only, and leaves them.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const {Queue} = require('bullmq');
const {ROOT, startServer, stopServer} = require('../helpers/sandbox-server');
const {testPort, redisConnectionFor} = require('../helpers/test-env');
const {prefixFor} = require('../helpers/job-queue');
const {deviceIDForName} = require('../../lib/call-address');
const tmp = require('../helpers/test-tmp').forFile(['ch-auth-56-']);

const KEY = `k${crypto.randomBytes(12).toString('hex')}`;
const RUNTIMES = {
  a: {port: testPort(9733), module: path.join(ROOT, 'test', 'fixtures', 'job-snoop'), device: deviceIDForName('job-snoop'),
    serviceID: 'urn:countinghouse-test:serviceID:jobService', actionName: 'whoami', input: {note: 'n'}},
  b: {port: testPort(9796), module: path.join(ROOT, 'pre-installed-packages', 'echo-device-module'), device: 'c5284c70-ae5f-591c-b2f1-cf0b4ebd0767',
    serviceID: 'urn:countinghouse-com:serviceID:echoService', actionName: 'echo', input: {foo: [{item1: 'x'}], bar: 'y'}}
};
// (the count is whatever this Redis holds under the old prefix: the job
// seeded here at least)
const LEGACY_SAID = /job queue: (\d+) jobs? and \d+ schedulers? under the old shared prefix \{cdifJob\} were not moved to this server's queue, and (\d+) job histor(?:y|ies) under the old jobinfo:<name> keys are not read/g;
const LEGACY_HISTORY = `jobinfo:legacy-56-${process.pid}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('auth 56: each runtime\'s job queue is its own (B-j1)', function() {
  this.timeout(120000);
  let legacy = null;
  let legacyJob = null;
  let kv = null;   // the store's kv (Redis db 5): a history list left unscoped

  before(async () => {
    // a job left under the shared prefix by a runtime before B-j1
    legacy = new Queue('job-queue', {prefix: '{cdifJob}', connection: redisConnectionFor(11)});
    legacyJob = await legacy.add(`legacy-56-${process.pid}`, {left: true});
    kv = new (require('ioredis'))(redisConnectionFor(5));
    await kv.lpush(LEGACY_HISTORY, JSON.stringify({job: {name: 'legacy-56'}, state: 'completed'}));
    for (const r of Object.values(RUNTIMES)) {
      const dir = tmp.mkdtemp('ch-auth-56-');
      const auth = path.join(dir, 'auth.json');
      fs.writeFileSync(auth, JSON.stringify({[KEY]: {userName: 'k', devices: ['*']}}));
      r.dataDir = path.join(dir, 'store');
      r.server = await startServer(r.port, ['--workerThread', '--authProvider', 'file', '--authConfigPath', auth,
        '--moduleDataPath', r.dataDir, '--loadModule', r.module]);
      r.queue = new Queue('job-queue', {prefix: prefixFor(r.dataDir), connection: redisConnectionFor(11)});
    }
  });
  after(async () => {
    for (const r of Object.values(RUNTIMES)) {
      if (r.queue != null) { await r.queue.obliterate({force: true}).catch(() => {}); await r.queue.close(); }
      if (r.server != null) stopServer(r.server);
    }
    if (legacyJob != null) await legacyJob.remove().catch(() => {});
    if (legacy != null) await legacy.close();
    if (kv != null) { await kv.del(LEGACY_HISTORY).catch(() => {}); kv.disconnect(); }
  });

  it('the prefix is the server\'s own: {chj-<its 16-hex id>}, kept in its data directory; another directory, another', () => {
    const [a, b] = Object.values(RUNTIMES).map((r) => prefixFor(r.dataDir));
    for (const p of [a, b]) assert.match(p, /^\{chj-[0-9a-f]{16}\}$/);
    assert.notStrictEqual(a, b);
    for (const r of Object.values(RUNTIMES)) {
      const id = fs.readFileSync(path.join(r.dataDir, '.server-id'), 'utf8');
      assert.strictEqual(prefixFor(r.dataDir), `{chj-${id}}`);
    }
  });

  it('two runtimes on one Redis each run only their own jobs, and every one completes', async () => {
    const added = {a: [], b: []};
    for (let i = 0; i < 8; i++) {
      for (const [name, r] of Object.entries(RUNTIMES)) {
        const res = await request(`http://127.0.0.1:${r.port}`).post(`/devices/${r.device}/add-job`).set('X-CH-Key', KEY)
          .send({serviceID: r.serviceID, actionName: r.actionName, opts: {name: `own-56-${i}`}, input: r.input});
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        added[name].push(res.body.id);
      }
    }
    const states = async () => {
      const out = {};
      for (const [name, r] of Object.entries(RUNTIMES)) {
        out[name] = await Promise.all(added[name].map(async (id) => { const j = await r.queue.getJob(id); return j == null ? 'missing' : j.getState(); }));
      }
      return out;
    };
    let seen = null;
    for (const end = Date.now() + 30000; Date.now() < end; await sleep(250)) {
      seen = await states();
      if (Object.values(seen).every((list) => list.every((s) => s === 'completed' || s === 'failed'))) break;
    }
    assert.deepStrictEqual(seen, {a: Array(8).fill('completed'), b: Array(8).fill('completed')});
    // (the jobs' history is each server's own list too: one name, two
    // servers, ids that now repeat across them)
    for (const r of Object.values(RUNTIMES)) {
      const h = await request(`http://127.0.0.1:${r.port}`).post(`/devices/${r.device}/get-job-history`).set('X-CH-Key', KEY).send({name: 'own-56-0'});
      assert.strictEqual(h.status, 200, JSON.stringify(h.body));
      const records = Array.isArray(h.body) ? h.body : [];
      assert.ok(records.length >= 1, JSON.stringify(h.body));
      assert.ok(records.every((x) => x.job != null && x.job.data != null && x.job.data.deviceID === r.device), JSON.stringify(records).slice(0, 800));
    }
  });

  it('a job left under the old shared prefix, and an unscoped history, are said once by each start, and left where they are', async () => {
    // (said once its counts are read, after the start: waited for)
    const once = new RegExp(LEGACY_SAID.source);
    for (const r of Object.values(RUNTIMES)) {
      for (const end = Date.now() + 15000; Date.now() < end && !once.test(r.server.output);) await sleep(100);
      const said = [...r.server.output.matchAll(LEGACY_SAID)];
      assert.strictEqual(said.length, 1, r.server.output.slice(-2000));
      assert.ok(Number(said[0][1]) >= 1, said[0][0]);
      assert.ok(Number(said[0][2]) >= 1, said[0][0]);
    }
    assert.strictEqual(await (await legacy.getJob(legacyJob.id)).getState(), 'waiting');
    assert.strictEqual(await kv.llen(LEGACY_HISTORY), 1, 'the old history list is read, never changed');
  });

  tmp.hooks();
});
