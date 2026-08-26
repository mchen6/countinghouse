const fs      = require('fs');
const exec    = require('child_process').exec;
const request = require('supertest');

// Standalone-only, same reason as 01-file-provider-tools-list-filtering.js
// and 06-admin-gating.js: needs a real (non---debug) server, since --debug
// resolves every apiKey to an isAdmin session (lib/user-auth.js), under
// which every task is legitimately visible to everyone and there is no
// "another tenant" to be isolated from. That is exactly why the gap this
// file covers survived: test/unit/test031.js and test032.js already exercise
// the task path end to end, but only under --debug.
//
// Covers the ownership model added in lib/job-control.js:
//   - a task records its creator's *authenticated* apiKey
//   - tasks/get|result|cancel require the caller to be that apiKey (or admin)
//   - tasks/list returns only the caller's own tasks
//   - no apiKey at all is refused outright
//   - the HTTP job routes (/get-job, /remove-job, /get-job-history) go
//     through the same gate, so they aren't a bypass around the MCP one
const PORT             = 9541;
const url              = `http://127.0.0.1:${PORT}`;
const AUTH_CONFIG_PATH = `/tmp/countinghouse-test-auth-07-${process.pid}.json`;

const ALICE   = 'alice-key';    // owns the tasks created below
const MALLORY = 'mallory-key';  // valid key, wildcard device access, owns nothing
const ADMIN   = 'admin-key';    // may read across tenants
const ECHO_TOOL = 'echo_device_echoservice_echo';

// echo-device-module's deviceID is deterministic (UUID.v5 of a fixed
// namespace and the module's api.json friendlyName -- see
// lib/call-address.js's deviceIDForName), so it can be hardcoded here the same way
// pre-installed-packages/composite-demo/device.js hardcodes its targets.
// Declared here rather than at the foot of the file, where `var` hoisting
// was the only thing making its use ~60 lines above the declaration work.
const DEVICE_ID = 'c5284c70-ae5f-591c-b2f1-cf0b4ebd0767';

// Deliberately given the SAME device access as alice. Ownership must not
// fall out of device access -- if mallory could read alice's task merely by
// being allowed to call the same device, the check would be meaningless.
function authConfig() {
  const config = {};
  config[ALICE]   = {userName: 'alice',   devices: ['*']};
  config[MALLORY] = {userName: 'mallory', devices: ['*']};
  config[ADMIN]   = {userName: 'admin',   devices: ['*'], admin: true};
  return config;
}

function mcp(key, body, cb) {
  const req = request(url).post('/mcp').set('Content-Type', 'application/json');
  if (key != null) req.set('X-CH-Key', key);
  req.send(body).end(cb);
}

describe('auth 07: MCP tasks/* and the HTTP job routes enforce per-tenant job ownership', function() {
  this.timeout(0);

  let aliceTaskId = null;

  before(function(done) {
    this.timeout(0);
    fs.writeFileSync(AUTH_CONFIG_PATH, JSON.stringify(authConfig()));

    console.log('starting countinghouse WITHOUT --debug, --authProvider file, for task-ownership test...');
    exec(`"./bin/countinghouse" --workerThread --bindAddr 127.0.0.1 --port ${PORT
         } --authProvider file --authConfigPath ${AUTH_CONFIG_PATH
         } --loadModule ./pre-installed-packages/echo-device-module`,
         (err, stdout, stderr) => { console.log(err); });
    setTimeout(() => { done(); }, 13000);
  });

  after((done) => {
    try { fs.unlinkSync(AUTH_CONFIG_PATH); } catch (e) {}
    exec(`pkill -f "framework.js.*${AUTH_CONFIG_PATH}"`, () => { done(); });
  });

  it('alice creates a task-augmented tools/call', (done) => {
    mcp(ALICE, {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: {
        name: ECHO_TOOL,
        arguments: {foo: [{item1: 'ALICE-CONFIDENTIAL'}], bar: 'alice-secret'},
        task: {}
      }
    }, (err, res) => {
      if (err) return done(err);
      if (res.body.result == null || res.body.result.task == null) {
        return done(new Error(`expected a created task, got: ${JSON.stringify(res.body)}`));
      }
      aliceTaskId = res.body.result.task.taskId;
      // let the job actually run so tasks/result has a real payload to leak
      setTimeout(done, 3000);
    });
  });

  it('alice can read the result of her own task', (done) => {
    mcp(ALICE, {jsonrpc: '2.0', id: 2, method: 'tasks/result', params: {taskId: aliceTaskId}}, (err, res) => {
      if (err) return done(err);
      const text = JSON.stringify(res.body);
      if (text.indexOf('ALICE-CONFIDENTIAL') === -1) {
        return done(new Error(`owner should still get her own result back, got: ${text}`));
      }
      return done();
    });
  });

  it('mallory CANNOT read alice\'s task result', (done) => {
    mcp(MALLORY, {jsonrpc: '2.0', id: 3, method: 'tasks/result', params: {taskId: aliceTaskId}}, (err, res) => {
      if (err) return done(err);
      const text = JSON.stringify(res.body);
      if (text.indexOf('ALICE-CONFIDENTIAL') !== -1) {
        return done(new Error(`cross-tenant task result leak: ${text}`));
      }
      if (res.body.error == null) {
        return done(new Error(`expected a JSON-RPC error for a non-owner, got: ${text}`));
      }
      return done();
    });
  });

  it('mallory CANNOT read alice\'s task metadata via tasks/get', (done) => {
    mcp(MALLORY, {jsonrpc: '2.0', id: 4, method: 'tasks/get', params: {taskId: aliceTaskId}}, (err, res) => {
      if (err) return done(err);
      if (res.body.error == null) {
        return done(new Error(`expected a JSON-RPC error for a non-owner, got: ${JSON.stringify(res.body)}`));
      }
      // indistinguishable from a genuinely missing id, so taskIds can't be enumerated
      if (String(res.body.error.message).indexOf('unknown task') === -1) {
        return done(new Error(`expected an "unknown task" style error, got: ${JSON.stringify(res.body)}`));
      }
      return done();
    });
  });

  it('mallory\'s tasks/list does NOT include alice\'s task', (done) => {
    mcp(MALLORY, {jsonrpc: '2.0', id: 5, method: 'tasks/list'}, (err, res) => {
      if (err) return done(err);
      if (res.body.result == null || !Array.isArray(res.body.result.tasks)) {
        return done(new Error(`expected a tasks array, got: ${JSON.stringify(res.body)}`));
      }
      const leaked = res.body.result.tasks.filter((t) => { return t.taskId === aliceTaskId; });
      if (leaked.length > 0) {
        return done(new Error(`tasks/list leaked another tenant's task: ${JSON.stringify(leaked)}`));
      }
      return done();
    });
  });

  it('alice\'s own tasks/list DOES include her task', (done) => {
    mcp(ALICE, {jsonrpc: '2.0', id: 6, method: 'tasks/list'}, (err, res) => {
      if (err) return done(err);
      const found = res.body.result.tasks.filter((t) => { return t.taskId === aliceTaskId; });
      if (found.length !== 1) {
        return done(new Error(`owner should see her own task in tasks/list, got: ${JSON.stringify(res.body)}`));
      }
      return done();
    });
  });

  it('an admin key CAN read across tenants', (done) => {
    mcp(ADMIN, {jsonrpc: '2.0', id: 7, method: 'tasks/get', params: {taskId: aliceTaskId}}, (err, res) => {
      if (err) return done(err);
      if (res.body.result == null || res.body.result.taskId !== aliceTaskId) {
        return done(new Error(`admin should be able to read any task, got: ${JSON.stringify(res.body)}`));
      }
      return done();
    });
  });

  ['tasks/get', 'tasks/result', 'tasks/cancel'].forEach((method) => {
    it(`no apiKey at all is refused on ${method}`, (done) => {
      mcp(null, {jsonrpc: '2.0', id: 8, method: method, params: {taskId: aliceTaskId}}, (err, res) => {
        if (err) return done(err);
        const text = JSON.stringify(res.body);
        if (res.body.error == null) {
          return done(new Error(`anonymous caller must be refused on ${method}, got: ${text}`));
        }
        if (text.indexOf('ALICE-CONFIDENTIAL') !== -1) {
          return done(new Error(`anonymous caller leaked task data on ${method}: ${text}`));
        }
        return done();
      });
    });
  });

  it('no apiKey at all is refused on tasks/list (no enumeration)', (done) => {
    mcp(null, {jsonrpc: '2.0', id: 9, method: 'tasks/list'}, (err, res) => {
      if (err) return done(err);
      if (res.body.error == null) {
        return done(new Error(`anonymous tasks/list must be refused, got: ${JSON.stringify(res.body)}`));
      }
      return done();
    });
  });

  // --- S5: the HTTP job routes must not be a way around the MCP gate ---

  it('HTTP /get-job: mallory cannot read alice\'s job', (done) => {
    request(url).post(`/devices/${DEVICE_ID}/get-job`)
      .set('X-CH-Key', MALLORY).send({id: aliceTaskId})
      .end((err, res) => {
        if (err) return done(err);
        const text = JSON.stringify(res.body);
        if (res.status === 200) return done(new Error(`HTTP get-job leaked another tenant's job: ${text}`));
        if (text.indexOf('ALICE-CONFIDENTIAL') !== -1) return done(new Error(`HTTP get-job leaked payload: ${text}`));
        return done();
      });
  });

  it('HTTP /remove-job: mallory cannot delete alice\'s job', (done) => {
    request(url).post(`/devices/${DEVICE_ID}/remove-job`)
      .set('X-CH-Key', MALLORY).send({name: ECHO_TOOL, id: aliceTaskId, isRepeat: false})
      .end((err, res) => {
        if (err) return done(err);
        if (res.status === 200 && res.body.removed === true) {
          return done(new Error('HTTP remove-job deleted another tenant\'s job'));
        }
        if (res.body.code !== 'JOB_ACCESS_DENIED') {
          return done(new Error(`expected JOB_ACCESS_DENIED, got: ${JSON.stringify(res.body)}`));
        }
        return done();
      });
  });

  it('HTTP /get-job-history: mallory gets no entries for alice\'s job name', (done) => {
    request(url).post(`/devices/${DEVICE_ID}/get-job-history`)
      .set('X-CH-Key', MALLORY).send({name: ECHO_TOOL})
      .end((err, res) => {
        if (err) return done(err);
        const text = JSON.stringify(res.body);
        if (text.indexOf(String(aliceTaskId)) !== -1) {
          return done(new Error(`HTTP get-job-history leaked another tenant's job records: ${text}`));
        }
        return done();
      });
  });

  it('alice\'s job survived every one of mallory\'s attempts', (done) => {
    mcp(ALICE, {jsonrpc: '2.0', id: 10, method: 'tasks/get', params: {taskId: aliceTaskId}}, (err, res) => {
      if (err) return done(err);
      if (res.body.result == null || res.body.result.taskId !== aliceTaskId) {
        return done(new Error(`alice's own task should be untouched, got: ${JSON.stringify(res.body)}`));
      }
      return done();
    });
  });

  it('the owner can cancel her own task', (done) => {
    mcp(ALICE, {jsonrpc: '2.0', id: 11, method: 'tasks/cancel', params: {taskId: aliceTaskId}}, (err, res) => {
      if (err) return done(err);
      if (res.body.result == null || res.body.result.status !== 'cancelled') {
        return done(new Error(`owner should be able to cancel her own task, got: ${JSON.stringify(res.body)}`));
      }
      return done();
    });
  });
});
