'use strict';
// R-redis-drop-spin: node_redis 3.1.2 drains its offline queue in on_ready
// (send_offline_queue) before it emits 'ready'. A command it sends there while
// the stream is not writable (Redis closed the connection as it answered the
// ready check) is pushed back onto the same queue while the queue is on, so
// the drain never ends: the main thread spins and nothing else runs. A
// redis-resilient client has its queue on until its first 'ready', so its
// first connect was exposed (a runtime starting while Redis restarts; a client
// made lazily as Redis closes). Each resilient client drains a snapshot of the
// queue: a command put back waits in the new one, and the drain answers it
// NR_CLOSED; one that throws as it is sent leaves the rest queued, answered
// at the first-connect bound.
//
// The client runs in a child process: on the old code it spins, so its own
// timers never fire and this file kills it (its process group) at the bound.
const assert = require('assert');
const path = require('path');
const {spawn} = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const BOUND_MS = 10000;

// The child: a fake Redis on an ephemeral port that answers the ready check
// (INFO) only after making the client's stream unwritable, as a stream whose
// peer has closed is; three commands queued before the connect. It prints
// one line: ANSWERED <codes> once every callback is answered and a later
// timer has fired (the loop is alive). argv[1]: a commandDeadlineMs for the
// client (0: none); with one, the line comes after three deadlines, so a
// command answered twice (NR_CLOSED, then REDIS_COMMAND_TIMEOUT) shows. (The
// fake server takes an ephemeral port in the child, so no testPort() row:
// nothing else can hold it; no client here reaches a Redis.)
const CHILD = `
const net = require('net');
const mode = process.argv[2] || 'unwritable';
const resilient = require(${JSON.stringify(path.join(ROOT, 'lib/redis-resilient'))});
let client = null;
const server = net.createServer((sock) => {
  sock.on('error', () => {});
  sock.on('data', (d) => {
    if (!/info/i.test(String(d))) return;
    if (mode === 'unwritable') Object.defineProperty(client.stream, 'writable', {configurable: true, get: () => false});
    const body = '# Server\\r\\nredis_version:7.0.0\\r\\n';
    sock.write('$' + Buffer.byteLength(body) + '\\r\\n' + body + '\\r\\n');
  });
});
server.listen(0, '127.0.0.1', () => {
  const deadline = Number(process.argv[1]);
  client = resilient.createClient(server.address().port, {host: '127.0.0.1'}, mode === 'throw' ? 1000 : 60000, {commandDeadlineMs: deadline});   // run-local: not the shared Redis
  client.on('error', () => {});
  const codes = [];
  const answered = (e) => {
    codes.push(e != null ? (e.code || 'error') : 'ok');
    if (codes.length < 3) return;
    setTimeout(() => { process.stdout.write('ANSWERED ' + codes.join(',') + '\\n'); process.exit(0); }, deadline > 0 ? deadline * 3 : 50);
  };
  if (mode === 'throw') {
    // (a sent, never answered by this server; b's object argument throws as
    // the drain sends it; c, after it, must still be answered)
    process.on('uncaughtException', () => {});
    client.get('a', () => {});
    client.set('b', {x: 1});
    client.get('c', (e) => { process.stdout.write('ANSWERED-C ' + (e != null ? (e.code || 'error') : 'ok') + '\\n'); process.exit(0); });
    return;
  }
  for (const k of ['a', 'b', 'c']) client.get(k, answered);
});
`;

describe('store 10: a resilient client whose stream closes as it becomes ready answers its queued commands (R-redis-drop-spin)', function() {
  this.timeout(BOUND_MS + 10000);

  // (the child stopped on every path: its process group, or the child
  // itself where there are none, Windows)
  async function runChild(deadlineMs, mode = 'unwritable') {
    const child = spawn(process.execPath, ['-e', CHILD, String(deadlineMs), mode], {stdio: ['ignore', 'pipe', 'pipe'], detached: true});
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    const stop = () => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { try { child.kill('SIGKILL'); } catch (e2) { /* gone */ } }
    };
    let timer = null;
    return new Promise((resolve) => {
      timer = setTimeout(() => { stop(); resolve('KILLED: no answer within the bound (the drain spins)'); }, BOUND_MS);
      // ('close': after the child's output is all read)
      child.on('close', () => resolve(out.trim()));
    }).finally(() => { clearTimeout(timer); stop(); });
  }

  it('every queued command is answered with an error, and the process stays live', async () => {
    assert.strictEqual(await runChild(0), 'ANSWERED NR_CLOSED,NR_CLOSED,NR_CLOSED');
  });

  it('with a command deadline, each is answered once (NR_CLOSED, never a later timeout too)', async () => {
    assert.strictEqual(await runChild(300), 'ANSWERED NR_CLOSED,NR_CLOSED,NR_CLOSED');
  });

  it('a command that throws as the drain sends it leaves the rest queued: answered at the first-connect bound', async () => {
    assert.strictEqual(await runChild(0, 'throw'), 'ANSWERED-C NR_CLOSED');
  });

  // (the fix replaces a node_redis internal: an upgrade must not undo it
  // unseen; the behavioural cases above are the real test)
  it('node_redis is 3.1.x, and its on_ready still drains with send_offline_queue', () => {
    const version = require('redis/package.json').version;
    const proto = require('redis').RedisClient.prototype;
    const recheck = 'node_redis changed: recheck the offline-queue drain (redis-resilient.js)';
    assert.ok(/^3\.1\./.test(version), `${recheck}: version ${version}, not 3.1.x`);
    assert.ok(typeof proto.send_offline_queue === 'function', `${recheck}: version ${version} has no send_offline_queue`);
    assert.ok(/this\.send_offline_queue\(\)/.test(String(proto.on_ready)), `${recheck}: version ${version}'s on_ready no longer calls send_offline_queue`);
  });
});
