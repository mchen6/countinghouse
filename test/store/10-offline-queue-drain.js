'use strict';
// R-redis-drop-spin: node_redis 3.1.2 drains its offline queue in on_ready
// (send_offline_queue) before it emits 'ready'. A command it sends there while
// the stream is not writable (Redis closed the connection as it answered the
// ready check) is pushed back onto the same queue while the queue is on, so
// the drain never ends: the main thread spins and nothing else runs. A
// redis-resilient client has its queue on until its first 'ready', so its
// first connect was exposed (a runtime starting while Redis restarts; a client
// made lazily as Redis closes). Each resilient client drains a snapshot of the
// queue: a command put back waits in the new one and is answered NR_CLOSED
// when 'ready' turns the queue off.
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
// timer has fired (the loop is alive). (Clients here are given a port and a
// host, never a Redis URL: none of them reaches a Redis.)
const CHILD = `
const net = require('net');
const resilient = require(${JSON.stringify(path.join(ROOT, 'lib/redis-resilient'))});
let client = null;
const server = net.createServer((sock) => {
  sock.on('error', () => {});
  sock.on('data', (d) => {
    if (!/info/i.test(String(d))) return;
    Object.defineProperty(client.stream, 'writable', {configurable: true, get: () => false});
    const body = '# Server\\r\\nredis_version:7.0.0\\r\\n';
    sock.write('$' + Buffer.byteLength(body) + '\\r\\n' + body + '\\r\\n');
  });
});
server.listen(0, '127.0.0.1', () => {
  client = resilient.createClient(server.address().port, {host: '127.0.0.1'}, 60000);   // run-local: not the shared Redis
  client.on('error', () => {});
  const codes = [];
  const answered = (e) => {
    codes.push(e != null ? (e.code || 'error') : 'ok');
    if (codes.length < 3) return;
    setTimeout(() => { process.stdout.write('ANSWERED ' + codes.join(',') + '\\n'); process.exit(0); }, 50);
  };
  for (const k of ['a', 'b', 'c']) client.get(k, answered);
});
`;

describe('store 10: a resilient client whose stream closes as it becomes ready answers its queued commands (R-redis-drop-spin)', function() {
  this.timeout(BOUND_MS + 10000);

  it('every queued command is answered with an error, and the process stays live', async () => {
    const child = spawn(process.execPath, ['-e', CHILD], {stdio: ['ignore', 'pipe', 'pipe'], detached: true});
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    const killGroup = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { /* gone */ } };
    let timer = null;
    const result = await new Promise((resolve) => {
      timer = setTimeout(() => { killGroup(); resolve('KILLED: no answer within the bound (the drain spins)'); }, BOUND_MS);
      child.on('exit', () => resolve(out.trim()));
    }).finally(() => { clearTimeout(timer); killGroup(); });
    assert.strictEqual(result, 'ANSWERED NR_CLOSED,NR_CLOSED,NR_CLOSED');
  });

  // (the fix replaces a node_redis internal: an upgrade must not undo it unseen)
  it('the drain is redis-resilient\'s own, on node_redis 3.1.x', () => {
    const version = require('redis/package.json').version;
    const client = require('../../lib/redis-resilient').createClient(1, {host: '127.0.0.1'}, 10);   // run-local: not the shared Redis
    client.on('error', () => {});
    try {
      const own = Object.prototype.hasOwnProperty.call(client, 'send_offline_queue');
      assert.ok(own && /^3\.1\./.test(version), 'node_redis changed: recheck the offline-queue drain (redis-resilient.js)');
    } finally {
      client.end(false);
    }
  });
});
