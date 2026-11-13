// A --stdio server for a test (bin/countinghouse-stdio.js) and the client end
// of its JSON-RPC lines, for test/stdio/02 and 03: each request answered as
// its line arrives on stdout, the server's stderr kept, and a stop that ends
// stdin and kills a server that lingers.
const {spawn} = require('child_process');
const path = require('path');

const ENTRY = path.join(__dirname, '..', '..', 'bin', 'countinghouse-stdio.js');

// The server's stderr for a failure message, without the Redis connection
// noise a test causes on purpose (--redisUrl points where nothing answers,
// so every Redis client and the job queue retry and log). Without this the
// tail held only that noise, and on Windows (issue #40) the real reason a
// module never listed was cut off. A noise block starts at one of these
// lines and runs through the indented stack and field lines and the closing
// brace that follow it; indented lines after anything else are kept.
const REDIS_NOISE = /ECONNREFUSED|Redis client error|Redis connection to|job queue error/;
const CONTINUATION = /^\s+\S|^\s*[{}]\s*$/;
function withoutRedisNoise(err, max = 4000) {
  const kept = [];
  let inNoise = false;
  for (const l of err.split('\n')) {
    if (l.trim() === '') continue;
    if (REDIS_NOISE.test(l)) { inNoise = true; continue; }
    if (inNoise && CONTINUATION.test(l)) continue;
    inNoise = false;
    kept.push(l);
  }
  const text = kept.join('\n');
  return text.length > max ? `…${text.slice(-max)}` : text;
}

// -> io: {child, err, lines, exited, notify(message), request(message,
// timeoutMs), stop(lingerMs)}. `args` follow the entry; `env` is added to the
// test's own. `lines` holds stdout's lines as written, a last one without
// its newline included once stdout has closed.
function startStdio(args, {env = {}} = {}) {
  const child = spawn(process.execPath, [ENTRY, ...args], {env: {...process.env, ...env}, stdio: ['pipe', 'pipe', 'pipe']});
  const io = {child, err: '', lines: []};
  const waiting = new Map();   // id -> {resolve, reject}
  let partial = '';
  let ended = null;
  let nextId = 1000000;
  const take = (l) => {
    if (l === '') return;
    io.lines.push(l);
    let m = null;
    try { m = JSON.parse(l); } catch (e) { return; }
    const w = (m != null && m.id != null) ? waiting.get(m.id) : null;
    if (w != null) { waiting.delete(m.id); w.resolve(m); }
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    const parts = (partial + d).split('\n');
    partial = parts.pop();
    parts.forEach(take);
  });
  child.stderr.on('data', (d) => { io.err += d; });
  child.stdin.on('error', () => { /* the server ended first: a pending request says so */ });
  // 'close', not 'exit': it comes after stdout and stderr are drained, so an
  // answer written just before the exit is still taken.
  io.exited = new Promise((resolve) => child.on('close', (code, signal) => {
    take(partial);
    partial = '';
    ended = {code, signal};
    for (const [, w] of waiting) w.reject(new Error(`the server exited (code ${code}, signal ${signal}) before answering; stderr without the Redis noise:\n${withoutRedisNoise(io.err)}`));
    waiting.clear();
    resolve(ended);
  }));

  io.notify = (message) => { if (ended == null) child.stdin.write(`${JSON.stringify(message)}\n`); };

  // The answer to `message` (given an id if it has none), or a rejection that
  // says why not: no answer in `timeoutMs`, or the server's exit.
  io.request = (message, timeoutMs = 15000) => {
    const m = (message.id != null) ? message : {...message, id: nextId++};
    if (ended != null) return Promise.reject(new Error(`the server had exited (code ${ended.code}, signal ${ended.signal}) before ${m.method}`));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(m.id);
        reject(new Error(`no answer to ${m.method} in ${timeoutMs} ms; stderr without the Redis noise:\n${withoutRedisNoise(io.err)}`));
      }, timeoutMs);
      waiting.set(m.id, {resolve: (a) => { clearTimeout(timer); resolve(a); }, reject: (e) => { clearTimeout(timer); reject(e); }});
      child.stdin.write(`${JSON.stringify(m)}\n`);
    });
  };

  // Ends stdin, then waits for the exit; a server still up after `lingerMs`
  // is killed. -> {code, signal}.
  io.stop = async(lingerMs = 15000) => {
    if (ended == null) child.stdin.end();
    let timer = null;
    const lingered = await Promise.race([io.exited, new Promise((r) => { timer = setTimeout(() => r('lingered'), lingerMs); })]);
    clearTimeout(timer);
    if (lingered === 'lingered') child.kill('SIGKILL');
    return io.exited;
  };
  return io;
}

const INITIALIZE = {jsonrpc: '2.0', method: 'initialize', params: {protocolVersion: '2026-07-28', capabilities: {}, clientInfo: {name: 'test', version: '0'}}};

// The first tool whose name matches `pattern`, asking tools/list every
// `everyMs` until `deadlineMs` has passed: null if none was listed by then.
// A tools/list that is not answered, or answered with an error, throws (its
// message carries the server's stderr), rather than being retried.
async function waitForTool(io, pattern, {deadlineMs = 60000, everyMs = 500} = {}) {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    const list = await io.request({jsonrpc: '2.0', method: 'tools/list'}, Math.max(1000, until - Date.now()));
    if (list.error != null) throw new Error(`tools/list answered an error: ${JSON.stringify(list.error)}; stderr without the Redis noise:\n${withoutRedisNoise(io.err)}`);
    const tool = ((list.result && list.result.tools) || []).find((t) => pattern.test(t.name));
    if (tool != null) return tool;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return null;
}

module.exports = {startStdio, waitForTool, withoutRedisNoise, INITIALIZE};
