const request = require('supertest');

const url = 'http://127.0.0.1:9527';

// docs/cross-cutting-matrix.md found that MCP tools/call error responses
// (lib/mcp/gateway.js's toolCallResult()) dropped err.code -- the locale-
// independent field CHError/DeviceError carry (see Sprint 4's
// worker-message.js fix) that HTTP invoke-action responses already
// exposed. Fixed by adding structuredContent: {code: err.code} to
// toolCallResult's error branch whenever err.code is present.
//
// Task-augmented failures surfaced via tasks/result had a second, deeper
// cause for the same symptom: bullmq only ever persists a failed job's
// reason as a plain string (job.failedReason = err.message), dropping any
// custom property -- including code -- before toolCallResult ever runs.
// Fixed in lib/job-control.js (encode "CODE: message" into the rejected
// error before bullmq serializes it) and lib/mcp/gateway.js's
// handleTasksResult (decode it back out).
describe('test32: MCP tools/call error responses carry err.code', function() {
  this.timeout(0);

  const badInput = {bar: 123}; // echoService/echo requires bar: string -- schema validation fails

  it('sync tools/call: an input-validation failure carries structuredContent.code', (done) => {
    request(url).post('/mcp')
    .set('Content-Type', 'application/json')
    .set('X-CH-Key', 'aabbcc')
    .send({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: {name: 'echo_device_echoservice_echo', arguments: badInput}
    })
    .expect(200, (err, res) => {
      if (err) return done(err);
      const result = res.body.result;
      if (result == null || result.isError !== true) {
        return done(new Error(`test32 fail: expected an isError:true result, got: ${JSON.stringify(res.body)}`));
      }
      if (result.structuredContent == null || result.structuredContent.code !== 'INPUT_DATA_VALIDATION_FAIL') {
        return done(new Error(`test32 fail: expected structuredContent.code === INPUT_DATA_VALIDATION_FAIL, got: ${JSON.stringify(result)}`));
      }
      return done();
    });
  });

  it('task-augmented tools/call: an input-validation failure carries structuredContent.code via tasks/result', (done) => {
    request(url).post('/mcp')
    .set('Content-Type', 'application/json')
    .send({jsonrpc: '2.0', id: 2, method: 'initialize', params: {protocolVersion: '2026-07-28'}})
    .expect(200, (err, res) => {
      if (err) return done(err);
      const tasksSupported = res.body.result != null
        && res.body.result.capabilities != null
        && res.body.result.capabilities.tasks != null;
      if (tasksSupported !== true) return done(); // single-thread mode: nothing to test here

      request(url).post('/mcp')
      .set('Content-Type', 'application/json')
      .set('X-CH-Key', 'aabbcc')
      .send({
        jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: {name: 'echo_device_echoservice_echo', arguments: badInput, task: {}}
      })
      .expect(200, (err, res) => {
        if (err) return done(err);
        const taskId = res.body.result != null && res.body.result.task != null ? res.body.result.task.taskId : null;
        if (taskId == null) return done(new Error(`test32 fail: expected a task to be created, got: ${JSON.stringify(res.body)}`));

        let attemptsLeft = 20;
        function pollResult() {
          attemptsLeft--;
          request(url).post('/mcp')
          .set('Content-Type', 'application/json')
          .set('X-CH-Key', 'aabbcc')
          .send({jsonrpc: '2.0', id: 4, method: 'tasks/result', params: {taskId: taskId}})
          .expect(200, (err, res) => {
            if (err) return done(err);
            if (res.body.result == null) {
              // not completed yet
              if (attemptsLeft <= 0) return done(new Error(`test32 fail: task ${taskId} did not complete in time`));
              return setTimeout(pollResult, 300);
            }
            const result = res.body.result;
            if (result.isError !== true) {
              return done(new Error(`test32 fail: expected task result isError:true, got: ${JSON.stringify(result)}`));
            }
            if (result.structuredContent == null || result.structuredContent.code !== 'INPUT_DATA_VALIDATION_FAIL') {
              return done(new Error(`test32 fail: expected structuredContent.code === INPUT_DATA_VALIDATION_FAIL, got: ${JSON.stringify(result)}`));
            }
            return done();
          });
        }
        pollResult();
      });
    });
  });
});
