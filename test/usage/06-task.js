// Task-augmented tools/call is counted (reviewer, 2026-11-11, step 3b). The
// job's start hook mints the call id in the process that runs the job; the
// In records happen during the run as on the direct path; the completion
// hook writes the Out record under the same id and, for a scenario's success,
// keeps the receipt in job.data; tasks/result adds it in _meta and as the
// second text block. Pure over a recorder and stub lookups: no queue.
const assert = require('assert');
const {createUsage} = require('../../lib/usage');
const {taskHooks, addTaskReceipt} = require('../../lib/usage/task');

const SCENARIO = {name: 'ci_failure_triage', role: 'scenario', module: 'ch-pack-ci-failure-triage', deviceID: 'd1', serviceID: 's', actionName: 'ci_failure_triage'};
const PLAIN = {name: 'plain_svc_go', role: null, module: 'plain', deviceID: 'd2', serviceID: 's', actionName: 'go'};
const job = (target, apiKey = 'k1') => ({deviceID: target.deviceID, serviceID: target.serviceID, actionName: target.actionName, input: {}, apiKey});
const built = (err, results) => (err != null
  ? {isError: true, content: [{type: 'text', text: err.message}]}
  : {isError: false, content: [{type: 'text', text: JSON.stringify(results.output)}], structuredContent: results.output});

describe('task-augmented tools/call: counting and the receipt', () => {
  let u, t, hooks;
  beforeEach(() => {
    t = Date.parse('2026-11-11T12:00:00Z');
    u = createUsage({usageDir: null, pid: 1, startMs: 1, now: () => t});
    hooks = taskHooks({
      usage: () => u,
      targetFor: (d) => [SCENARIO, PLAIN].find((x) => x.deviceID === d.deviceID && x.serviceID === d.serviceID && x.actionName === d.actionName) || null,
      callerOf: (apiKey) => (apiKey == null ? null : `u_${apiKey}`),
      buildResult: built,
      now: () => t
    });
  });

  it('the start hook mints a call in this process, with the pack, the tool and the opaque caller', () => {
    const extra = hooks.start(job(SCENARIO));
    assert.ok(Number.isInteger(extra.usageCall));
    assert.deepStrictEqual(Object.keys(extra), ['usageCall'], 'nothing but the id reaches the worker');
    t += 40;
    hooks.complete(job(SCENARIO), {output: {summary: 'x'}}, {extra});
    const out = u.records()[0];
    assert.deepStrictEqual([out.call, out.pack, out.module, out.tool, out.caller, out.ms], [extra.usageCall, 'ch-pack-ci-failure-triage', 'ch-pack-ci-failure-triage', 'ci_failure_triage', 'u_k1', 40]);
  });

  it('a job that is not a listed tool is not counted', () => {
    assert.strictEqual(hooks.start({deviceID: 'nope', serviceID: 's', actionName: 'x', apiKey: 'k1'}), null);
    assert.strictEqual(hooks.start(null), null);
    assert.strictEqual(u.records().length, 0);
  });

  it('a scenario\'s success: the Out record under the same id, the receipt kept for tasks/result with the run\'s In records', () => {
    const extra = hooks.start(job(SCENARIO));
    u.recordIn(extra.usageCall, {server: 'github', module: 'ch-access-github', tool: 'get_job_logs', bytes: 2048, lines: 20, ms: 3, outcome: 'ok', credential: 'GITHUB_TOKEN'});
    u.recordIn(extra.usageCall, {server: 'github', module: 'ch-access-github', tool: 'get_job_logs', bytes: 2048, lines: 20, ms: 3, outcome: 'ok', credential: 'GITHUB_TOKEN'});
    const output = {summary: 'it broke'};
    const kept = hooks.complete(job(SCENARIO), {output}, {extra});
    const text = JSON.stringify(output);
    assert.deepStrictEqual(kept.usageReceipt, {calls: 2, linesIn: 40, bytesIn: 4096, linesOut: 1, bytesOut: Buffer.byteLength(text), servers: ['github']});
    assert.match(kept.usageSentence, /^read 40 lines \(4\.0 KB\) in 2 calls to github; 1 line \(\d+ B\) reached the model\.$/);
    const out = u.records().filter((r) => r.bytesOut !== undefined);
    assert.deepStrictEqual(out.map((r) => [r.call, r.outcome, r.bytesOut]), [[extra.usageCall, 'ok', Buffer.byteLength(text)]]);
  });

  it('a failed run is counted with outcome error, and keeps no receipt', () => {
    const extra = hooks.start(job(SCENARIO));
    assert.strictEqual(hooks.complete(job(SCENARIO), null, {extra, error: new Error('it timed out')}), null);
    const out = u.records()[0];
    assert.deepStrictEqual([out.call, out.outcome, out.bytesOut], [extra.usageCall, 'error', Buffer.byteLength('it timed out')]);
  });

  it('a module output with a top-level receipt is counted as an error and keeps no receipt', () => {
    const extra = hooks.start(job(SCENARIO));
    assert.strictEqual(hooks.complete(job(SCENARIO), {output: {receipt: {calls: 9}}}, {extra}), null);
    assert.strictEqual(u.records()[0].outcome, 'error');
  });

  it('a module that is not a scenario gets its Out record and no receipt', () => {
    const extra = hooks.start(job(PLAIN));
    assert.strictEqual(hooks.complete(job(PLAIN), {output: {ok: true}}, {extra}), null);
    assert.deepStrictEqual([u.records()[0].pack, u.records()[0].module, u.records()[0].outcome], [null, 'plain', 'ok']);
  });

  it('a retried job is a new call each run', () => {
    const a = hooks.start(job(SCENARIO));
    const b = hooks.start(job(SCENARIO));
    assert.notStrictEqual(a.usageCall, b.usageCall);
  });

  it('counting never fails a job: no id, or an id this process never minted, is skipped', () => {
    assert.strictEqual(hooks.complete(job(SCENARIO), {output: {}}, {}), null);
    assert.strictEqual(hooks.complete(job(SCENARIO), {output: {}}, {extra: {usageCall: 999}}), null);
    assert.strictEqual(hooks.complete(job(SCENARIO), {output: {}}, undefined), null);
    assert.strictEqual(u.records().length, 0);
  });

  it('a run\'s worker gets input, jobID and an integer usageCall from the start hook, nothing else', () => {
    const jobArgs = require('../../lib/job-args');
    assert.deepStrictEqual(jobArgs({a: 1}, 'j1', {usageCall: 7}), {input: {a: 1}, jobID: 'j1', usageCall: 7});
    assert.deepStrictEqual(jobArgs({a: 1}, 'j1', {usageCall: '7', apiKey: 'k', input: {b: 2}}), {input: {a: 1}, jobID: 'j1'});
    assert.deepStrictEqual(jobArgs({a: 1}, 'j1', null), {input: {a: 1}, jobID: 'j1'});
  });

  it('tasks/result adds the kept receipt in _meta and as a second text block, structuredContent untouched', () => {
    const output = {summary: 'x'};
    const r = addTaskReceipt(built(null, {output}), {usageReceipt: {calls: 0, linesIn: 0, bytesIn: 0, linesOut: 1, bytesOut: 15, servers: []}, usageSentence: 'no server was called; 1 line (15 B) reached the model.'});
    assert.deepStrictEqual(r.structuredContent, output);
    assert.deepStrictEqual(r.content.map((c) => c.text), [JSON.stringify(output), 'no server was called; 1 line (15 B) reached the model.']);
    assert.deepStrictEqual(r._meta['countinghouse/receipt'].servers, []);
    const plain = built(null, {output});
    assert.strictEqual(addTaskReceipt(plain, {}), plain);
    const failed = built(new Error('no'));
    assert.strictEqual(addTaskReceipt(failed, {usageReceipt: {calls: 0}, usageSentence: 's'}), failed);
  });
});
