const request = require('supertest');

const url = 'http://127.0.0.1:9527';

// docs/cross-cutting-matrix.md found that MCP task-augmented tools/call
// (params.task) never called userAuth -- any apiKey could task-augment a
// call against a device it doesn't own and have it execute. Fixed in
// lib/mcp/gateway.js's createTaskForToolCall, which now applies the same
// userAuth gate the synchronous tools/call path already had, before
// checking rateLimit and creating the job.
//
// Single-thread mode (test2.js's server) doesn't support tasks at all
// (CdifInterface.tasksSupported() requires --workerThread), so a
// task-augmented call is rejected before userAuth would ever run there --
// this test checks initialize's advertised capabilities first and only
// asserts the userAuth-specific behavior when tasks are actually supported.
describe('test31: MCP task-augmented tools/call enforces userAuth', function() {
  this.timeout(0);

  function tasksSupported(callback) {
    request(url).post('/mcp')
    .set('Content-Type', 'application/json')
    .send({jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion: '2026-07-28'}})
    .expect(200, (err, res) => {
      if (err) return callback(err);
      const supported = res.body.result != null
        && res.body.result.capabilities != null
        && res.body.result.capabilities.tasks != null;
      return callback(null, supported);
    });
  }

  it('rejects a task-augmented call from an apiKey with no access to the device, without creating a task', (done) => {
    tasksSupported((err, supported) => {
      if (err) return done(err);

      request(url).post('/mcp')
      .set('Content-Type', 'application/json')
      .set('X-CH-Key', 'not-a-real-key')
      .send({
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: {
          name: 'echo_device_echoservice_echo',
          arguments: {foo: [], bar: 'should not run'},
          task: {}
        }
      })
      .expect(200, (err, res) => {
        if (err) return done(err);

        if (supported !== true) {
          // tasks aren't supported at all in this mode -- the request is
          // rejected before userAuth would run, nothing to assert about it.
          if (res.body.error == null) return done(new Error('test31 fail: expected an error when tasks are unsupported'));
          return done();
        }

        if (res.body.error == null) {
          return done(new Error(`test31 fail: expected task-augmented call with an unauthorized apiKey to be rejected, got: ${JSON.stringify(res.body)}`));
        }
        if (res.body.result != null && res.body.result.task != null) {
          return done(new Error('test31 fail: a task should not have been created for an unauthorized apiKey'));
        }
        return done();
      });
    });
  });

  it('still creates and completes a task for an apiKey that does have access', (done) => {
    tasksSupported((err, supported) => {
      if (err) return done(err);
      if (supported !== true) return done(); // nothing to test in this mode

      request(url).post('/mcp')
      .set('Content-Type', 'application/json')
      .set('X-CH-Key', 'aabbcc')
      .send({
        jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: {
          name: 'echo_device_echoservice_echo',
          arguments: {foo: [], bar: 'ok'},
          task: {}
        }
      })
      .expect(200, (err, res) => {
        if (err) return done(err);
        if (res.body.result == null || res.body.result.task == null || res.body.result.task.taskId == null) {
          return done(new Error(`test31 fail: expected a task to be created for an authorized apiKey, got: ${JSON.stringify(res.body)}`));
        }
        return done();
      });
    });
  });
});
