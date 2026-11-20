const fs      = require('fs');
const {deviceIDForName} = require('../../lib/call-address');
const exec    = require('child_process').exec;
const waitForReady = require('../helpers/wait-for-ready');
const {testPort, redisFlag, startShell, stopAll} = require('../helpers/test-env');
const request = require('supertest');

// sqlite3 is an optionalDependency, and the failure mode that matters is not
// "it wasn't installed" -- it is "it installed fine and its prebuilt native
// binding still won't load", because the prebuild needs glibc >= 2.38 and
// plenty of supported hosts (Ubuntu 22.04 LTS: 2.35) have less. That is a
// require-time failure, so optionalDependencies alone does not cover it.
//
// This asserts the thing that actually matters to a user on such a host:
// everything except the sqlite backend works normally. The server is started
// with a preload that makes require('sqlite3') throw ERR_DLOPEN_FAILED, so
// the environment is genuinely sqlite3-less without touching node_modules.
const PORT             = testPort(9591);
const url              = `http://127.0.0.1:${PORT}`;
const AUTH_CONFIG_PATH = `/tmp/countinghouse-test-nosqlite-${process.pid}.json`;
const PRELOAD          = './test/fixtures/no-sqlite3-preload.js';

const KEY   = `nosqlite-key-${process.pid}`;
const OTHER = `nosqlite-other-${process.pid}`;

const DEVICE_ID  = deviceIDForName('echo-device');
const SERVICE_ID = 'urn:countinghouse-com:serviceID:echoService';
const ECHO_INPUT = {foo: [{item1: 'x'}], bar: 'y'};

describe('module-loading 02: with sqlite3 unloadable, the file backend still works end to end', function() {
  this.timeout(0);

  before(function(done) {
    this.timeout(0);
    const config = {};
    config[KEY]   = {userName: 'nosqlite', devices: ['*']};
    config[OTHER] = {userName: 'other',    devices: []};
    fs.writeFileSync(AUTH_CONFIG_PATH, JSON.stringify(config));

    console.log('starting countinghouse with sqlite3 made unloadable, --authProvider file...');
    waitForReady(startShell(`node -r ${PRELOAD} ./framework.js${redisFlag()} --workerThread --bindAddr 127.0.0.1 --port ${PORT
         } --authProvider file --authConfigPath ${AUTH_CONFIG_PATH
         } --mcpToolCallCost 1` +
         ` --loadModule ./pre-installed-packages/echo-device-module`,
         () => {}), done);
  });

  after((done) => {
    try { fs.unlinkSync(AUTH_CONFIG_PATH); } catch (e) {}
    // matched on the per-pid auth config path, not on the preload filename:
    // a pattern like "no-sqlite3-preload" also matches any shell that merely
    // mentions it, including the one running mocha.
    stopAll(done);
  });

  it('the server starts at all (the documented --loadModule path never touches the registry DB)', (done) => {
    request(url).post('/mcp').set('Content-Type', 'application/json').set('X-CH-Key', KEY)
      .send({jsonrpc: '2.0', id: 1, method: 'ping'})
      .expect(200, (err, res) => {
        if (err) return done(err);
        if (res.body.result == null) return done(new Error(`ping failed: ${JSON.stringify(res.body)}`));
        return done();
      });
  });

  it('tools/list works and is still filtered per apiKey', (done) => {
    request(url).post('/mcp').set('Content-Type', 'application/json').set('X-CH-Key', KEY)
      .send({jsonrpc: '2.0', id: 2, method: 'tools/list'})
      .end((err, res) => {
        if (err) return done(err);
        const names = res.body.result.tools.map((t) => { return t.name; });
        if (names.indexOf('echo_device_echoservice_echo') === -1) {
          return done(new Error(`expected the echo tool, got: ${JSON.stringify(names)}`));
        }
        // the device-less key must still see only the platform tools: the balance
        // check and the usage report, listed to every key (local-mode spec §5)
        request(url).post('/mcp').set('Content-Type', 'application/json').set('X-CH-Key', OTHER)
          .send({jsonrpc: '2.0', id: 3, method: 'tools/list'})
          .end((err, res2) => {
            if (err) return done(err);
            const n2 = res2.body.result.tools.map((t) => { return t.name; });
            if (JSON.stringify(n2.slice().sort()) !== JSON.stringify(['countinghouse_check_balance', 'countinghouse_overview', 'countinghouse_usage_report'])) {
              return done(new Error(`per-apiKey filtering broken without sqlite3: ${JSON.stringify(n2)}`));
            }
            return done();
          });
      });
  });

  it('tools/call round-trips', (done) => {
    request(url).post('/mcp').set('Content-Type', 'application/json').set('X-CH-Key', KEY)
      .send({jsonrpc: '2.0', id: 4, method: 'tools/call',
             params: {name: 'echo_device_echoservice_echo', arguments: ECHO_INPUT}})
      .end((err, res) => {
        if (err) return done(err);
        if (res.body.result == null || res.body.result.isError === true) {
          return done(new Error(`tools/call failed without sqlite3: ${JSON.stringify(res.body)}`));
        }
        return done();
      });
  });

  // The balance once every charge has settled: metering is asynchronous, so
  // the tools/call just before this case may still be landing (#230's run:
  // 0 -> -2). Settled is the same value on two reads SETTLE_GAP_MS apart,
  // within SETTLE_WITHIN_MS. It never waits for the value the test expects.
  const SETTLE_GAP_MS = 200;
  const SETTLE_WITHIN_MS = 5000;
  const balance = () => new Promise((resolve, reject) => {
    request(url).get('/balance').set('X-CH-Key', KEY).end((err, res) => (err ? reject(err) : resolve(res.body.balance)));
  });
  const settledBalance = async() => {
    const until = Date.now() + SETTLE_WITHIN_MS;
    let last = await balance();
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, SETTLE_GAP_MS));
      const now = await balance();
      if (now === last) return now;
      last = now;
    }
    throw new Error(`the balance did not settle within ${SETTLE_WITHIN_MS} ms (last ${last})`);
  };

  it('HTTP invoke-action works and is metered', async() => {
    const before = await settledBalance();
    await request(url).post(`/devices/${DEVICE_ID}/invoke-action`).set('X-CH-Key', KEY)
      .send({serviceID: SERVICE_ID, actionName: 'echo', input: ECHO_INPUT})
      .expect(200);
    const after = await settledBalance();
    if (after !== before - 1) throw new Error(`metering broken without sqlite3: ${before} -> ${after}`);
  });

  it('authorization still denies an unauthorized key', (done) => {
    request(url).post('/mcp').set('Content-Type', 'application/json').set('X-CH-Key', OTHER)
      .send({jsonrpc: '2.0', id: 5, method: 'tools/call',
             params: {name: 'echo_device_echoservice_echo', arguments: ECHO_INPUT}})
      .end((err, res) => {
        if (err) return done(err);
        if (res.body.error == null) {
          return done(new Error(`a key with no device grants must be refused, got: ${JSON.stringify(res.body)}`));
        }
        return done();
      });
  });

  it('selecting the sqlite backend fails with an actionable message, not a loader stack', (done) => {
    // separate short-lived process: this is expected to fail at startup
    exec(`node -r ${PRELOAD} -e "` +
         `var p=require('./lib/auth/sqlite-provider');` +
         `try { new p({dbPath:'/tmp/should-not-be-created-'+process.pid+'.sqlite3'}); }` +
         `catch(e) { console.log(e.message); }"`,
         (err, stdout) => {
           const text = String(stdout);
           [
             'requires the optional "sqlite3" package',
             'glibc >= 2.38',                 // the reason
             'this system has glibc',          // the observed version
             '--build-from-source',            // way out (a)
             '--authProvider file'             // way out (b)
           ].forEach((needle) => {
             if (text.indexOf(needle) === -1) {
               throw new Error(`expected the diagnostic to mention "${needle}", got: ${text}`);
             }
           });
           return done();
         });
  });
});
