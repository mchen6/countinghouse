'use strict';
// MCP completeness M16, Task 2 (plan
// docs/superpowers/plans/2026-11-17-mcp-m16-task-notifications.md): a
// client that names its 2026-07-28 tasks on subscriptions/listen
// (notifications.taskIds) is sent notifications/tasks -- the task as tasks/get
// answers it at that moment -- when one changes.
//
// In-process first: the hub (lib/mcp/subscriptions.js) with a stand-in
// taskView and clock. Who hears a task is decided only by the listener's
// taskView at each send, never by the event; a working task's notices are
// coalesced to at most one per TASK_NOTICE_MS, the latest; a terminal one
// is sent at once, once, and its id leaves the set; one the view no longer
// reads leaves silently; a task already terminal at the listen is sent
// after the ack; a closed listener frees its timers and writes nothing.
// Then spawned (a server, --workerThread --store local, two keys): the ack,
// the gate, and each kind of change end to end. M22's question (#374):
// input_required keeps the id, its wait's end is told by task-events
// (in-process), and an answered task runs to completed (spawned, both
// stores).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const {createHub, SUBSCRIPTION_ID_KEY, MAX_TASK_IDS} = require('../../lib/mcp/subscriptions');
const {ROOT, startServer, stopServer} = require('../helpers/sandbox-server');
const {testPort} = require('../helpers/test-env');

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe('mcp-contract 37: notifications/tasks, the hub (M16 Task 2, in-process)', () => {
  // a hub with a clock the test moves, and tasks the test sets
  // fail(taskId): the view's answer instead of the task's, when it returns
  // one (a rejection is transient; {revoked: true} the key gone)
  function rig({noticeMs = 1000, fail = () => undefined} = {}) {
    let clock = 1000;
    const tasks = new Map();
    const views = [];
    const hub = createHub({lists: {}, taskNoticeMs: noticeMs, now: () => clock});
    const view = (taskId) => {
      views.push(taskId);
      const f = fail(taskId);
      if (f !== undefined) return f instanceof Error ? Promise.reject(f) : Promise.resolve(f);
      return Promise.resolve(tasks.has(taskId) ? JSON.parse(JSON.stringify(tasks.get(taskId))) : null);
    };
    const open = (ids, id = 7) => {
      const out = [];
      const ended = {count: 0};
      const opened = hub.open({id, appKey: 'k', filter: {taskIds: ids}, write: (m) => out.push(m), finish: (why) => { ended.count += 1; ended.why = why; }, taskView: view});
      assert.ok(opened.ok);
      return {out, opened, ended, sent: () => out.map((m) => `${m.params.taskId} ${m.params.status}${m.params.statusMessage != null ? ` ${m.params.statusMessage}` : ''}`)};
    };
    return {hub, tasks, views, open, advance: (ms) => { clock += ms; }, set: (id, status, extra = {}) => tasks.set(id, Object.assign({taskId: id, status}, extra))};
  }
  const settle = () => tick(5);

  // the high review of #433, 1: a transient failure keeps the id, tried again
  it('a view that fails transiently keeps the task: tried again after the window, and told', async () => {
    let failing = true;
    const r = rig({noticeMs: 30, fail: () => (failing ? new Error('the store blinked') : undefined)});
    r.set('t-1', 'working');
    const l = r.open(['t-1']);
    r.set('t-1', 'completed', {result: {content: []}});
    r.hub.taskChanged('t-1', 'completed');
    await settle();
    assert.deepStrictEqual(l.sent(), [], 'nothing yet');
    assert.strictEqual(r.hub.count('k'), 1, 'kept');
    failing = false;
    await tick(60);
    assert.deepStrictEqual(l.sent(), ['t-1 completed']);
  });

  // the high review of #433, 1 and 3: a revoked key ends the listen, and a
  // taskIds-only listen with nothing left ends, its slot freed
  it('a revoked key ends its listen at once; a listen whose every task is done ends too', async () => {
    const r = rig({fail: (t) => (t === 't-revoked' ? {revoked: true} : undefined)});
    r.set('t-a', 'working');
    r.set('t-b', 'working');
    const gone = r.open(['t-a', 't-revoked'], 8);
    r.hub.taskChanged('t-revoked', 'progress');
    await settle();
    assert.strictEqual(gone.ended.count, 1, 'ended');
    assert.strictEqual(gone.ended.why, 'revoked', 'told why: the transport answers it as an error');
    assert.deepStrictEqual(gone.sent(), []);
    const done = r.open(['t-a', 't-b'], 9);
    r.set('t-a', 'completed', {result: {content: []}});
    r.hub.taskChanged('t-a', 'completed');
    await settle();
    assert.strictEqual(done.ended.count, 0, 't-b still pending');
    r.tasks.delete('t-b');   // gone: tasks/get would say -32602
    r.hub.taskChanged('t-b', 'failed');
    await settle();
    assert.strictEqual(done.ended.count, 1, 'nothing left: ended');
    assert.strictEqual(r.hub.count('k'), 0, 'every slot freed');
  });

  // the medium review of #433's high fixes, 3: a first step that failed is
  // tried again as a first step, so a task working at the listen is not sent
  it('a failed first step is retried as one: a task working at the listen is still not sent', async () => {
    let failing = true;
    const r = rig({noticeMs: 20, fail: () => (failing ? new Error('the store blinked') : undefined)});
    r.set('t-1', 'working', {statusMessage: '40%'});
    const l = r.open(['t-1']);
    l.opened.start();
    await settle();
    failing = false;
    await tick(60);
    assert.deepStrictEqual(l.sent(), [], 'working at the listen: not sent');
    r.set('t-1', 'completed', {result: {content: []}});
    r.hub.taskChanged('t-1', 'completed');
    await settle();
    assert.deepStrictEqual(l.sent(), ['t-1 completed']);
  });

  // the medium review of #433's high fixes, 2: a failure that never clears
  // is no longer transient: the id goes, and a listen with nothing left ends
  it('a view that always fails drops its task after MAX_TASK_RETRIES tries, and the emptied listen ends', async () => {
    const {MAX_TASK_RETRIES} = require('../../lib/mcp/subscriptions');
    const r = rig({noticeMs: 2, fail: () => new Error('always')});
    r.set('t-1', 'working');
    const l = r.open(['t-1']);
    r.hub.taskChanged('t-1', 'progress');
    assert.ok(await until(() => l.ended.count === 1, 5000), `ended after ${r.views.length} tries`);
    assert.strictEqual(r.views.length, MAX_TASK_RETRIES + 1);
    assert.strictEqual(l.ended.why, undefined, 'a graceful end');
  });

  // the high review of #433, 10: a change builds only for the listeners that hold it
  it('a task\'s change builds views only for the listeners holding its id', async () => {
    const r = rig();
    r.set('t-1', 'working');
    r.set('t-2', 'working');
    r.open(['t-1'], 11);
    r.open(['t-2'], 12);
    await settle();
    r.views.length = 0;
    r.set('t-1', 'working', {statusMessage: '10%'});
    r.hub.taskChanged('t-1', 'progress');
    await settle();
    assert.deepStrictEqual(r.views, ['t-1']);
  });

  it('a change is sent as the view builds the task, with the listen\'s subscription id; the event\'s kind decides nothing', async () => {
    const r = rig();
    r.set('t-1', 'working');
    const l = r.open(['t-1']);
    r.set('t-1', 'working', {statusMessage: '10%'});
    r.hub.taskChanged('t-1', 'completed');   // a kind that says otherwise: the view decides
    await settle();
    assert.deepStrictEqual(l.sent(), ['t-1 working 10%']);
    assert.strictEqual(l.out[0].method, 'notifications/tasks');
    assert.strictEqual(l.out[0].params._meta[SUBSCRIPTION_ID_KEY], 7);
    r.hub.taskChanged('t-other', 'progress');
    await settle();
    assert.strictEqual(l.out.length, 1, 'an id it doesn\'t hold');
  });

  it('a working task\'s notices: at most one per window, the latest at its end; nothing repeated', async () => {
    const r = rig();
    r.set('t-1', 'working');
    const l = r.open(['t-1']);
    r.set('t-1', 'working', {statusMessage: '10%'});
    r.hub.taskChanged('t-1');
    await settle();
    r.set('t-1', 'working', {statusMessage: '50%'});
    r.hub.taskChanged('t-1');
    r.set('t-1', 'working', {statusMessage: '90%'});
    r.hub.taskChanged('t-1');
    await settle();
    assert.deepStrictEqual(l.sent(), ['t-1 working 10%'], 'held within the window');
    r.advance(1000);
    await tick(1050);
    assert.deepStrictEqual(l.sent(), ['t-1 working 10%', 't-1 working 90%'], 'the latest, once');
    r.advance(5000);
    r.hub.taskChanged('t-1');
    await settle();
    assert.strictEqual(l.out.length, 2, 'the same task again says nothing');
  });

  it('a terminal task is sent at once, within a window too, exactly once; its id then leaves, and its held timer goes', async () => {
    const r = rig();
    r.set('t-1', 'working');
    const l = r.open(['t-1']);
    // (each with its kind, as task-events tells it: a terminal kind builds
    // at once even while the window's send is pending)
    r.set('t-1', 'working', {statusMessage: '10%'});
    r.hub.taskChanged('t-1', 'progress');
    await settle();
    r.set('t-1', 'working', {statusMessage: '50%'});
    r.hub.taskChanged('t-1', 'progress');
    await settle();
    r.set('t-1', 'completed', {result: {content: []}});
    r.hub.taskChanged('t-1', 'completed');
    await settle();
    assert.deepStrictEqual(l.sent(), ['t-1 working 10%', 't-1 completed']);
    const built = r.views.length;
    r.advance(5000);
    await tick(1050);
    r.hub.taskChanged('t-1', 'completed');
    await settle();
    assert.deepStrictEqual(l.sent(), ['t-1 working 10%', 't-1 completed'], 'nothing after');
    assert.strictEqual(r.views.length, built, 'its id left: never built again');
  });

  it('an id the view no longer reads (its job gone, another session\'s, its session ended) leaves the set silently', async () => {
    const r = rig();
    r.set('t-1', 'working');
    const l = r.open(['t-1']);
    r.tasks.delete('t-1');
    r.hub.taskChanged('t-1');
    await settle();
    r.set('t-1', 'completed');
    r.hub.taskChanged('t-1');
    await settle();
    assert.deepStrictEqual(l.out, [], 'left at the first send that read nothing');
  });

  it('start: a task already terminal at the listen is sent once; a working one waits for a change', async () => {
    const r = rig();
    r.set('t-done', 'completed', {result: {content: []}});
    r.set('t-run', 'working');
    const l = r.open(['t-done', 't-run']);
    l.opened.start();
    await settle();
    assert.deepStrictEqual(l.sent(), ['t-done completed']);
    r.hub.taskChanged('t-done');
    await settle();
    assert.strictEqual(l.out.length, 1);
  });

  it('a listener closed with a notice held writes nothing after, and its timer is freed', async () => {
    const r = rig();
    r.set('t-1', 'working');
    const l = r.open(['t-1']);
    r.set('t-1', 'working', {statusMessage: '10%'});
    r.hub.taskChanged('t-1');
    await settle();
    r.set('t-1', 'working', {statusMessage: '50%'});
    r.hub.taskChanged('t-1');
    await settle();
    const viewsBefore = r.views.length;
    l.opened.close();
    r.advance(1000);
    await tick(1100);
    assert.deepStrictEqual(l.sent(), ['t-1 working 10%']);
    assert.strictEqual(r.views.length, viewsBefore, 'no build after the close: its timer was cleared');
  });

  // M22: input_required is not terminal (the view decides), so its id is
  // kept; its question's wait ends unseen (tasks/get reads ASK_EXPIRED from
  // the record's expiresAt), so task-events tells it, wired as route-manager
  // wires the hub, with task-asks' record stood in for
  it('a task waiting on its question: input_required sent, its id kept; its wait\'s end, told by task-events, sent once as the task reads it', async () => {
    const taskEvents = require('../../lib/task-events');
    const taskAsks = require('../../lib/task-asks');
    const id = `t-${'e'.repeat(32)}`;
    const records = {[`task-ask:${id}`]: JSON.stringify({owner: 'o', expiresAt: Date.now() + 200})};
    taskAsks.configure({kv: () => ({get: (k, cb) => setImmediate(cb, null, records[k] != null ? records[k] : null)})});
    const r = rig();
    const off = taskEvents.on((t, kind) => r.hub.taskChanged(t, kind));
    try {
      r.set(id, 'working');
      const l = r.open([id]);
      r.set(id, 'input_required', {statusMessage: 'waiting for an answer'});
      taskEvents.emit(id, 'input_required');
      await settle();
      assert.deepStrictEqual(l.sent(), [`${id} input_required waiting for an answer`]);
      // as tasks/get reads it once the wait has passed
      r.set(id, 'failed', {statusMessage: 'ASK_EXPIRED'});
      await tick(100);
      assert.strictEqual(l.out.length, 1, 'not before its wait ends');
      assert.ok(await (async () => { for (let i = 0; i < 40 && l.out.length < 2; i++) await tick(25); return l.out.length === 2; })(), JSON.stringify(l.sent()));
      assert.deepStrictEqual(l.sent(), [`${id} input_required waiting for an answer`, `${id} failed ASK_EXPIRED`]);
      taskEvents.emit(id, 'failed');
      await settle();
      assert.strictEqual(l.out.length, 2, 'once: the id has left the set');
      assert.strictEqual(taskEvents.pendingWaits(), 0);
    } finally {
      off();
      taskAsks.configure({kv: () => require('../../lib/store').getStore().kv});
    }
  });

  // /code-review medium of T2: a flood of changes is one build at a time
  it('a flood of changes builds one view at a time, never one per change; while a window\'s send is pending only a terminal kind builds', async () => {
    const r = rig();
    r.set('t-1', 'working');
    const l = r.open(['t-1']);
    for (let i = 0; i < 100; i++) {
      r.set('t-1', 'working', {statusMessage: `${i}%`});
      r.hub.taskChanged('t-1', 'progress');
    }
    await settle();
    assert.ok(r.views.length <= 2, `${r.views.length} builds for 100 changes`);
    assert.deepStrictEqual(l.sent(), ['t-1 working 99%'], 'the latest, once');
    r.set('t-1', 'working', {statusMessage: '100%'});
    r.hub.taskChanged('t-1', 'progress');   // inside the window: its send is timed
    await settle();
    const timed = r.views.length;
    for (let i = 0; i < 50; i++) r.hub.taskChanged('t-1', 'progress');
    await settle();
    assert.strictEqual(r.views.length, timed, 'nothing built while the window\'s send is pending');
    r.set('t-1', 'completed');
    r.hub.taskChanged('t-1', 'completed');
    await settle();
    assert.strictEqual(r.views.length, timed + 1, 'a terminal kind builds at once');
    assert.deepStrictEqual(l.sent(), ['t-1 working 99%', 't-1 completed']);
  });

  it('at the listen: a task waiting on its question is sent after the ack; a working one is not', async () => {
    const r = rig();
    r.set('t-1', 'input_required', {statusMessage: 'waiting for an answer'});
    r.set('t-2', 'working');
    const l = r.open(['t-1', 't-2']);
    l.opened.start();
    await settle();
    assert.deepStrictEqual(l.sent(), ['t-1 input_required waiting for an answer']);
  });

  it('a listen holds at most MAX_TASK_IDS (64): the gateway refuses more, and the hub never holds more', async () => {
    assert.strictEqual(MAX_TASK_IDS, 64);
    const r = rig();
    const ids = Array.from({length: MAX_TASK_IDS + 5}, (_, i) => `t-${i}`);
    for (const t of ids) r.set(t, 'completed');
    const l = r.open(ids);
    l.opened.start();
    await settle();
    assert.strictEqual(l.out.length, MAX_TASK_IDS);
  });
});

// Spawned: the gateway's half, end to end, over HTTP
const V = '2026-07-28';
const EXT = 'io.modelcontextprotocol/tasks';
const KEY_A = `test-a-${'a'.repeat(24)}`;
const KEY_B = `test-b-${'b'.repeat(24)}`;
// revoked mid-listen by the reload-auth case, and used by it alone
const KEY_C = `test-c-${'c'.repeat(24)}`;
const ADMIN = `test-admin-${'d'.repeat(20)}`;
const KEYS = {[KEY_A]: {userName: 'a', devices: ['*']}, [KEY_B]: {userName: 'b', devices: ['*']}, [KEY_C]: {userName: 'c', devices: ['*']},
  [ADMIN]: {userName: 'admin', devices: ['*'], admin: true}};
const tool = (a) => `m15_tasks_taskservice_${a}`;
const META = (ext = true, forms = false) => ({'io.modelcontextprotocol/protocolVersion': V,
  'io.modelcontextprotocol/clientCapabilities': Object.assign(ext ? {extensions: {[EXT]: {}}} : {}, forms ? {elicitation: {form: {}}} : {})});
// M22's fixture: a task that asks its user (asks once, beforeMs into each pass)
const ASK_TOOL = 'm22_task_ask_askservice_probe';

// the request's Mcp-Name, as its body names it (27's NAME_PARAM)
const NAME_PARAM = {'tools/call': 'name', 'tasks/get': 'taskId', 'tasks/update': 'taskId', 'tasks/cancel': 'taskId'};
function post(port, key, method, params, {ext = true, forms = false} = {}) {
  const data = JSON.stringify({jsonrpc: '2.0', id: 1, method, params: Object.assign({_meta: META(ext, forms)}, params)});
  const headers = {'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', 'Content-Length': Buffer.byteLength(data),
    'X-CH-Key': key, 'MCP-Protocol-Version': V, 'Mcp-Method': method};
  if (NAME_PARAM[method] != null) headers['Mcp-Name'] = params[NAME_PARAM[method]];
  return new Promise((resolve, reject) => {
    const req = http.request({host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers}, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { raw += c; });
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch (e) { resolve({raw, status: res.statusCode}); } });
    });
    req.on('error', reject);
    req.end(data);
  });
}
// a POST to another route (an admin's /reload-auth): {status, body}
function raw(port, key, route, body) {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({host: '127.0.0.1', port, path: route, method: 'POST', headers: {'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data), 'X-CH-Key': key}}, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({status: res.statusCode, body: text.slice(0, 500)}));
    });
    req.on('error', reject);
    req.end(data);
  });
}
// a listen: resolves once the response starts; events (each SSE data line,
// parsed) arrive in `events`; a JSON answer (an error) in `answer`
// forms: the listen declares form elicitation in its own request, as a
// waiting task's form needs (F2-5)
function listen(port, key, notifications, {ext = true, id = 50, forms = false} = {}) {
  const data = JSON.stringify({jsonrpc: '2.0', id, method: 'subscriptions/listen', params: {_meta: META(ext, forms), notifications}});
  return new Promise((resolve, reject) => {
    const req = http.request({host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: {'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream', 'Content-Length': Buffer.byteLength(data), 'X-CH-Key': key, 'MCP-Protocol-Version': V,
      'Mcp-Method': 'subscriptions/listen'}}, (res) => {
      const out = {res, req, events: [], raw: '', ended: false, answer: null};
      res.setEncoding('utf8');
      const sse = /event-stream/.test(String(res.headers['content-type']));
      res.on('data', (c) => {
        out.raw += c;
        if (!sse) return;
        let i;
        while ((i = out.raw.indexOf('\n\n')) >= 0) {
          const block = out.raw.slice(0, i);
          out.raw = out.raw.slice(i + 2);
          const line = block.split('\n').find((x) => x.startsWith('data: '));
          if (line != null) out.events.push(JSON.parse(line.slice(6)));
        }
      });
      res.on('end', () => { out.ended = true; if (!sse) { try { out.answer = JSON.parse(out.raw); } catch (e) { out.answer = out.raw; } } });
      resolve(out);
    });
    req.on('error', reject);
    req.end(data);
  });
}
const until = async (test, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await test()) return true; await tick(50); }
  return test();
};
const notices = (s) => s.events.filter((e) => e.method === 'notifications/tasks').map((e) => e.params);

// full: every case; else the change paths only (the second store)
function spawnedSuite(label, extraArgs, port, {full = true} = {}) {
  const each = full ? it : () => {};
  describe(`mcp-contract 37: notifications/tasks end to end (${label})`, function() {
    this.timeout(120000);
    let server = null;
    let authPath = null;
    let dir = null;
    const streams = [];
    before(async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-mcp-28-'));
      const auth = path.join(dir, 'auth.json');
      authPath = auth;
      fs.writeFileSync(auth, JSON.stringify(KEYS), {mode: 0o600});
      server = await startServer(port, ['--workerThread', ...extraArgs, '--jobTimeout', '5', '--moduleDataPath', path.join(dir, 'module_data'),
        '--authConfigPath', auth, '--loadModule', path.join(ROOT, 'test', 'fixtures', 'm15-tasks'),
        '--loadModule', path.join(ROOT, 'test', 'fixtures', 'm22-task-ask')]);
    });
    // ext-tasks: never notifications/progress or notifications/message on a
    // task's listen stream -- checked on every stream each case opened
    afterEach(() => {
      for (const s of streams.splice(0)) {
        s.req.destroy();
        const stray = s.events.filter((e) => e.method === 'notifications/progress' || e.method === 'notifications/message');
        assert.deepStrictEqual(stray, [], 'no progress or message line on a task listen');
      }
    });
    after(() => {
      stopServer(server);
      if (dir != null) fs.rmSync(dir, {recursive: true, force: true});
    });
    const open = async (...args) => { const s = await listen(port, ...args); streams.push(s); return s; };
    const task = async (key, action, args) => {
      const r = await post(port, key, 'tools/call', {name: tool(action), arguments: args});
      assert.match(String(r.result && r.result.taskId), /^t-/, JSON.stringify(r));
      return r.result.taskId;
    };
    const get = async (key, taskId, opts) => (await post(port, key, 'tasks/get', {taskId}, opts)).result;
    // M22's fixture, listed, then called with form elicitation declared: the
    // new task's id (the medium review of T2: one setup for the asking cases)
    const askingTask = async (args) => {
      assert.ok(await until(async () => {
        const l = await post(port, KEY_A, 'tools/list', {});
        return l.result != null && l.result.tools.some((x) => x.name === ASK_TOOL);
      }, 30000), 'the M22 fixture never listed');
      const r = await post(port, KEY_A, 'tools/call', {name: ASK_TOOL, arguments: args}, {forms: true});
      const t = r.result && r.result.taskId;
      assert.match(String(t), /^t-/, JSON.stringify(r));
      return t;
    };
    const ackOf = (s) => s.events.find((e) => e.method === 'notifications/subscriptions/acknowledged');

    each('the ack lists only the caller\'s own tasks; another key\'s, an unknown and a malformed id are left out alike', async () => {
      const own = await task(KEY_A, 'slow', {ms: 3000});
      const foreign = await task(KEY_B, 'slow', {ms: 3000});
      const unknown = `t-${'0'.repeat(32)}`;
      const s = await open(KEY_A, {taskIds: [own, foreign, unknown, 'not-a-task', own]});
      assert.ok(await until(() => ackOf(s) != null), s.raw);
      assert.deepStrictEqual(ackOf(s).params.notifications, {taskIds: [own]});
      const f = await open(KEY_A, {taskIds: [foreign]});
      const u = await open(KEY_A, {taskIds: [unknown]});
      assert.ok(await until(() => ackOf(f) != null && ackOf(u) != null));
      assert.deepStrictEqual(ackOf(f).params.notifications, {taskIds: []});
      assert.deepStrictEqual(ackOf(f).params.notifications, ackOf(u).params.notifications, 'another key\'s task acks as an unknown one');
      assert.ok(await until(() => f.ended && u.ended), 'agreeing to nothing holds no stream open');
    });

    // the progress is reported only after the listen's ack: M22's probe asks
    // first and reports on its answered pass, which the test answers once the
    // listen has its ack (the high review of #433, 4: a slow runner or a fast
    // one can no longer race the listen)
    it('progress is notified working "NN%", coalesced; then completed with tasks/get\'s result, once; nothing after', async () => {
      const t = await askingTask({what: 'it', values: [10, 50, 90], gapMs: 300, afterMs: 1500});
      const s = await open(KEY_A, {taskIds: [t]}, {forms: true});
      assert.ok(await until(() => ackOf(s) != null && notices(s).some((n) => n.status === 'input_required'), 20000), JSON.stringify(s.events));
      const form = (await get(KEY_A, t, {forms: true})).inputRequests;
      await post(port, KEY_A, 'tasks/update', {taskId: t, inputResponses: {[Object.keys(form)[0]]: {action: 'accept', content: {yes: true}}}}, {forms: true});
      assert.ok(await until(() => notices(s).some((n) => n.status === 'completed'), 20000), JSON.stringify(s.events));
      const got = await get(KEY_A, t);
      await tick(1500);
      const all = notices(s);
      const working = all.filter((n) => n.status === 'working');
      const done = all.filter((n) => ['completed', 'failed', 'cancelled'].includes(n.status));
      assert.deepStrictEqual(done.map((n) => n.status), ['completed'], 'once, and nothing after');
      assert.deepStrictEqual(done[0].result, got.result, 'tasks/get\'s own result');
      assert.ok(working.length >= 1 && working.length <= 4, JSON.stringify(working));
      assert.strictEqual(working[working.length - 1].statusMessage, '90%', 'the latest');
      for (const n of all) assert.strictEqual(n._meta[SUBSCRIPTION_ID_KEY], 50);
    });

    it('a run that left no answer is notified failed, with its error and statusMessage', async () => {
      const t = await task(KEY_A, 'slow', {ms: 8000});
      const s = await open(KEY_A, {taskIds: [t]});
      assert.ok(await until(() => notices(s).some((n) => n.status === 'failed'), 20000), JSON.stringify(s.events));
      const failed = notices(s).find((n) => n.status === 'failed');
      assert.strictEqual(failed.error.code, -32603);
      assert.strictEqual(failed.statusMessage, (await get(KEY_A, t)).statusMessage);
    });

    it('an owner\'s cancel of a running task is notified cancelled once; nothing when its run ends', async () => {
      const t = await task(KEY_A, 'slow', {ms: 4000});
      const s = await open(KEY_A, {taskIds: [t]});
      assert.ok(await until(() => ackOf(s) != null));
      await tick(300);
      assert.ok((await post(port, KEY_A, 'tasks/cancel', {taskId: t})).result != null);
      // told by the cancel itself, well before the run's end (not by it)
      assert.ok(await until(() => notices(s).some((n) => n.status === 'cancelled'), 1500), JSON.stringify(s.events));
      await tick(4500);   // past its run's end
      assert.deepStrictEqual(notices(s).filter((n) => n.status !== 'working').map((n) => n.status), ['cancelled']);
    });

    // M22, on both stores: the ask's pass is told input_required (never
    // completed) with tasks/get's own form, the id kept; answered, the run
    // again is told working, then completed once
    it('a task that asks: input_required with its form, its id kept; answered, working again, then completed once', async () => {
      const t = await askingTask({what: 'it', beforeMs: 1500});
      const s = await open(KEY_A, {taskIds: [t]}, {forms: true});
      assert.ok(await until(() => notices(s).some((n) => n.status === 'input_required'), 20000), JSON.stringify(s.events));
      const asked = notices(s).find((n) => n.status === 'input_required');
      assert.strictEqual(asked.statusMessage, 'waiting for an answer');
      const got = await get(KEY_A, t, {forms: true});
      assert.strictEqual(got.status, 'input_required', JSON.stringify(got));
      assert.deepStrictEqual(asked.inputRequests, got.inputRequests, 'tasks/get\'s own form');
      const key = Object.keys(asked.inputRequests)[0];
      const waiting = notices(s).length;
      await tick(1200);
      assert.strictEqual(notices(s).length, waiting, 'nothing more while it waits');
      assert.ok(!s.ended, 'its id is kept');
      const answered = await post(port, KEY_A, 'tasks/update', {taskId: t, inputResponses: {[key]: {action: 'accept', content: {yes: true}}}}, {forms: true});
      assert.ok(answered.result != null, JSON.stringify(answered));
      assert.ok(await until(() => notices(s).some((n) => n.status === 'completed'), 20000), JSON.stringify(s.events));
      await tick(1500);
      // (a working notice may come first: the first pass's start can reach
      // the hub after the listen opened)
      const seq = notices(s).map((n) => n.status);
      const from = seq.indexOf('input_required');
      assert.ok(seq.slice(0, from).every((x) => x === 'working'), JSON.stringify(seq));
      assert.deepStrictEqual(seq.slice(from), ['input_required', 'working', 'completed'], JSON.stringify(seq));
      const done = notices(s).find((n) => n.status === 'completed');
      assert.deepStrictEqual(done.result, (await get(KEY_A, t)).result, 'tasks/get\'s own result');
      assert.deepStrictEqual(done.result.structuredContent.answer, {yes: true});
    });

    it('a task already waiting on its question when the listen opens is sent after the ack, with its form', async () => {
      const t = await askingTask({what: 'it'});
      assert.ok(await until(async () => (await get(KEY_A, t)).status === 'input_required'), 'it asked');
      const s = await open(KEY_A, {taskIds: [t]}, {forms: true});
      assert.ok(await until(() => notices(s).length > 0), JSON.stringify(s.events));
      assert.strictEqual(s.events[0].method, 'notifications/subscriptions/acknowledged', 'the ack first');
      assert.deepStrictEqual(notices(s).map((n) => n.status), ['input_required']);
      assert.deepStrictEqual(notices(s)[0].inputRequests, (await get(KEY_A, t, {forms: true})).inputRequests, 'tasks/get\'s own form');
      const key = Object.keys(notices(s)[0].inputRequests)[0];
      await post(port, KEY_A, 'tasks/update', {taskId: t, inputResponses: {[key]: {action: 'decline'}}}, {forms: true});
      assert.ok(await until(() => notices(s).some((n) => n.status === 'completed'), 20000), JSON.stringify(s.events));
    });

    // F2-5 on the listen stream: a listen that did not declare form
    // elicitation hears the task as tasks/get tells such a request, no form
    it('a listen without form elicitation hears a waiting task without its form, as tasks/get says it', async () => {
      const t = await askingTask({what: 'it'});
      assert.ok(await until(async () => (await get(KEY_A, t)).status === 'input_required'), 'it asked');
      const s = await open(KEY_A, {taskIds: [t]});
      assert.ok(await until(() => notices(s).length > 0), JSON.stringify(s.events));
      const n = notices(s)[0];
      const plain = await get(KEY_A, t);
      assert.deepStrictEqual([n.status, n.statusMessage, n.inputRequests], [plain.status, plain.statusMessage, plain.inputRequests]);
      assert.deepStrictEqual(n.inputRequests, {}, 'no form');
      const form = (await get(KEY_A, t, {forms: true})).inputRequests;
      await post(port, KEY_A, 'tasks/update', {taskId: t, inputResponses: {[Object.keys(form)[0]]: {action: 'decline'}}}, {forms: true});
      assert.ok(await until(() => notices(s).some((x) => x.status === 'completed'), 20000), JSON.stringify(s.events));
    });

    // /code-review medium of T2: each send resolves the caller again
    each('a key revoked while it listens (POST /reload-auth) hears nothing more of its task, its result least of all', async () => {
      const t = await task(KEY_C, 'slow', {ms: 1500});
      const s = await open(KEY_C, {taskIds: [t]});
      assert.ok(await until(() => ackOf(s) != null));
      assert.deepStrictEqual(ackOf(s).params.notifications, {taskIds: [t]});
      const kept = Object.assign({}, KEYS);
      delete kept[KEY_C];
      fs.writeFileSync(authPath, JSON.stringify(kept), {mode: 0o600});
      const reloaded = await raw(port, ADMIN, '/reload-auth', {});
      assert.strictEqual(reloaded.status, 200, JSON.stringify(reloaded));
      await tick(3000);   // past its run's end
      assert.deepStrictEqual(notices(s), [], JSON.stringify(s.events));
      // and its listen ended, answered as an unknown key, never "complete"
      // (the medium review of #433's high fixes, 7)
      assert.ok(await until(() => s.ended), 'ended');
      const last = s.events[s.events.length - 1];
      assert.strictEqual(last.id, 50, JSON.stringify(s.events));
      assert.strictEqual(last.error && last.error.data && last.error.data['countinghouse/code'], 'SYSTEM_ERROR_UNKNOWN_USER', JSON.stringify(last));
    });

    each('a task already completed at the listen is sent once, after the ack', async () => {
      const t = await task(KEY_A, 'slow', {ms: 0});
      assert.ok(await until(async () => (await get(KEY_A, t)).status === 'completed'));
      const s = await open(KEY_A, {taskIds: [t]});
      assert.ok(await until(() => notices(s).length > 0), JSON.stringify(s.events));
      assert.strictEqual(s.events[0].method, 'notifications/subscriptions/acknowledged', 'the ack first');
      await tick(500);
      assert.deepStrictEqual(notices(s).map((n) => n.status), ['completed']);
    });

    each('taskIds without the extension declared is -32021, naming it; more than 64 ids is -32602', async () => {
      const no = await open(KEY_A, {taskIds: []}, {ext: false});
      assert.ok(await until(() => no.ended));
      assert.strictEqual(no.answer.error.code, -32021, JSON.stringify(no.answer));
      assert.deepStrictEqual(no.answer.error.data.requiredCapabilities, {extensions: {[EXT]: {}}});
      const many = await open(KEY_A, {taskIds: Array.from({length: 65}, (_, i) => `t-${String(i).padStart(32, '0')}`)});
      assert.ok(await until(() => many.ended));
      assert.strictEqual(many.answer.error.code, -32602, JSON.stringify(many.answer));
    });
  });
}

spawnedSuite('--store local', ['--store', 'local'], testPort(9671));
// the Redis runner's QueueEvents: the change paths again (run-local's private Redis)
spawnedSuite('--store redis', [], testPort(9672), {full: false});

// the high review of #433, 5: each id a listen agrees to spends one of the
// caller's rate-limit tokens, so a listen of many ids costs what as many
// polls would; an id the budget no longer covers is not agreed
describe('mcp-contract 37: a listen\'s task ids spend the caller\'s rate limit, one each', function() {
  this.timeout(120000);
  const port = testPort(9673);
  let server = null;
  let dir = null;
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-mcp-37rl-'));
    const auth = path.join(dir, 'auth.json');
    fs.writeFileSync(auth, JSON.stringify(KEYS), {mode: 0o600});
    // three tokens a second per key (lib/store.js: a one-second rolling
    // window), under --store redis, whose metering builds the limiter
    // whenever --apiKeyRateLimit is set (the local store's only when it meters)
    server = await startServer(port, ['--workerThread', '--apiKeyRateLimit', '3', '--jobTimeout', '5',
      '--moduleDataPath', path.join(dir, 'module_data'), '--authConfigPath', auth, '--loadModule', path.join(ROOT, 'test', 'fixtures', 'm15-tasks')]);
  });
  after(() => {
    stopServer(server);
    if (dir != null) fs.rmSync(dir, {recursive: true, force: true});
  });
  it('a listen of three ids within one second agrees to the two its budget covers after the listen\'s own token', async () => {
    const ids = [];
    for (let i = 0; i < 3; i++) {
      // each call in a window of its own
      await tick(1100);
      const r = await post(port, KEY_A, 'tools/call', {name: tool('slow'), arguments: {ms: 4000}});
      assert.match(String(r.result && r.result.taskId), /^t-/, JSON.stringify(r));
      ids.push(r.result.taskId);
    }
    await tick(1100);
    const s = await listen(port, KEY_A, {taskIds: ids});
    try {
      assert.ok(await until(() => s.events.length > 0), s.raw);
      // the listen spends one token, then one per id: three in the second
      assert.deepStrictEqual(s.events[0].params.notifications.taskIds, ids.slice(0, 2));
    } finally {
      s.req.destroy();
    }
  });
});
