'use strict';
// The runtime's session listener (the shared-runtime design section 1, the
// wire contract, contract 2): the Rust shim's peer. It takes connections on
// the session socket, makes the handshake (the secret is never sent), and
// serves each authenticated connection as one session of the registry.
//
// Per connection, in order:
//   pre-auth  HELLO -> PROVE -> AUTH -> WELCOME or REFUSED. At most
//             preAuthMax at once; a new one past that evicts the OLDEST.
//             Each has preAuthDeadlineMs to be welcomed, and at most 512
//             bytes are read before its HELLO is complete.
//   welcomed  the first `client` frame decides: a failed one, or a token
//             unlike the daemon's, is `own-runtime` and the connection
//             closes; otherwise `settled`. An M before settled closes.
//   live      M frames are dispatched (lib/session-transport/lines.js: no
//             call runs without a seq) to onMessage(s, message, reply), and
//             C frames are the session's (client, replay, bye).
// An answer is written with its request's seq; one over maxToShim is
// never written, and OUTPUT_TOO_LARGE goes on its seq instead.
const net = require('net');
const frames = require('./frames');
const handshake = require('./handshake');
const lines = require('./lines');

const PRE_AUTH_MAX = 64;
const PRE_AUTH_DEADLINE_MS = 2000;
const READ_BEFORE_HELLO = 512;
const SUPPORTED_PROTOCOLS = [frames.PROTOCOL];
const MAX_SESSIONS = 256;
// a welcomed connection's wait for its first client frame: longer than the
// shim's 10 s for its conditions child
const WELCOMED_DEADLINE_MS = 12000;
const MAX_REPLAY = 64;
// the M frame's own bytes around a line: the 5-byte head, the 2-byte header
// length and a {"seq":n} header
const M_OVERHEAD = 5 + 2 + 32;

const TOO_LARGE = (id) => ({jsonrpc: '2.0', id: id === undefined ? null : id, error: {code: -32603, message: 'the answer is larger than this connection carries',
  data: {'countinghouse/code': 'OUTPUT_TOO_LARGE', retryable: false}}});

// path: the Unix socket; secret: the 32 bytes; registry: createRegistry's;
// tokenMac(secret) -> Buffer | null: the daemon's token's keyed hash (null:
// the daemon has none); onMessage(s, message, reply): reply(obj) answers a
// request (ignored for a notification). maxSessions: past it a handshake is
// refused BUSY. maxWriteBuffer: a connection whose unwritten bytes pass it
// (a peer that doesn't read) is closed.
function createListener({path: socketPath, secret, registry, runtimeVersion, maxToRuntime, maxToShim, tokenMac = null, onMessage,
  preAuthMax = PRE_AUTH_MAX, preAuthDeadlineMs = PRE_AUTH_DEADLINE_MS, welcomedDeadlineMs = WELCOMED_DEADLINE_MS, maxSessions = MAX_SESSIONS, maxWriteBuffer}) {
  for (const [name, v] of [['maxToRuntime', maxToRuntime], ['maxToShim', maxToShim]]) {
    if (!Number.isSafeInteger(v) || v < 0) throw new Error(`${name} ${v} is not a non-negative integer`);
  }
  const preAuth = [];          // connections not yet welcomed, oldest first
  const all = new Set();
  const live = new Set();      // the conns of settled sessions
  const daemonMac = typeof(tokenMac) === 'function' ? tokenMac(secret) : null;
  const writeBound = Number.isSafeInteger(maxWriteBuffer) ? maxWriteBuffer : maxToShim + 1024 * 1024;
  let draining = false;

  const server = net.createServer((sock) => {
    all.add(sock);
    sock.on('close', () => all.delete(sock));
    serve(sock);
  });

  function serve(sock) {
    // hello -> auth -> welcomed -> live, or closed from any of them
    let stage = 'hello';
    let bytesBeforeHello = 0;
    let nc = null;
    let ns = null;
    let protocol = null;
    let session = null;
    let replayed = false;
    let welcomed = null;     // the deadline for the first client frame

    const write = (kind, obj) => {
      if (sock.destroyed || stage === 'closed') return;
      sock.write(frames.encode(kind, typeof(obj) === 'string' ? obj : JSON.stringify(obj)));
      if (sock.writableLength > writeBound) shut();
    };
    // the terminal stage: nothing more is read, delivered or written, the
    // queued bytes flush, then the socket goes
    const shut = () => {
      if (stage === 'closed') return;
      stage = 'closed';
      decoder.stop();
      // a connection not yet welcomed stays in the pre-auth list until its
      // socket is gone (the close handler), so evict-oldest still reaches it
      clearTimeout(welcomed);
      if (!sock.destroyed) {
        sock.end();
        const t = setTimeout(() => sock.destroy(), 1000);
        if (typeof(t.unref) === 'function') t.unref();
      }
    };
    const close = () => { shut(); sock.destroy(); };
    const refuse = (code, message, extra) => { write('R', Object.assign({code, message}, extra || {})); shut(); };

    preAuth.push(sock);
    if (preAuth.length > preAuthMax) preAuth.shift().destroy();
    const deadline = setTimeout(close, preAuthDeadlineMs);
    if (typeof(deadline.unref) === 'function') deadline.unref();
    function leavePreAuth() {
      clearTimeout(deadline);
      const k = preAuth.indexOf(sock);
      if (k >= 0) preAuth.splice(k, 1);
    }
    sock.on('close', () => {
      stage = 'closed';
      leavePreAuth();
      live.delete(conn);
      // a session that never settled ends with its connection; a settled
      // one is detached, for its reconnect window
      if (session != null && session._conn === conn) {
        if (session._announced === true) session._detach();
        else session._end();
      }
    });
    sock.on('error', () => {});

    // the connection, as the session sees it: only once settled
    const conn = {
      settled: false,
      notify: (obj) => { if (conn.settled) writeM(null, obj); },
      control: (obj) => { if (conn.settled) write('C', obj); },
      close: () => shut()
    };

    function writeM(header, obj) {
      if (sock.destroyed || stage === 'closed') return;
      let line = Buffer.from(JSON.stringify(obj), 'utf8');
      if (line.length + M_OVERHEAD > maxToShim) {
        if (header == null) return;      // a notification too large to carry: dropped
        line = Buffer.from(JSON.stringify(TOO_LARGE(obj != null ? obj.id : null)), 'utf8');
        if (line.length + M_OVERHEAD > maxToShim) line = Buffer.from(JSON.stringify(TOO_LARGE(null)), 'utf8');
      }
      sock.write(frames.encode('M', frames.encodeM(header, line)));
      if (sock.writableLength > writeBound) shut();
    }

    const ALLOWED = {hello: 'H', auth: 'A', welcomed: 'C', live: 'CM', closed: ''};
    const decoder = frames.createDecoder({caps: {M: maxToRuntime}, allow: (kind) => ALLOWED[stage].includes(kind), onFrame: guarded, onError: close});
    sock.on('data', (chunk) => {
      if (stage === 'closed') return;
      if (stage === 'hello') {
        bytesBeforeHello += chunk.length;
        if (bytesBeforeHello > READ_BEFORE_HELLO) return close();
      }
      decoder.push(chunk);
    });

    // a JSON object, decoded fatally, or null
    function parse(payload) {
      try {
        const o = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(payload));
        return (o != null && typeof(o) === 'object' && !Array.isArray(o)) ? o : null;
      } catch (e) {
        return null;
      }
    }

    // nothing a peer sends throws out of the listener: a fault closes its
    // connection
    function guarded(kind, payload) {
      if (stage === 'closed') return;
      try {
        onFrame(kind, payload);
      } catch (e) {
        close();
      }
    }

    function onFrame(kind, payload) {
      if (stage === 'hello') {
        const hello = parse(payload);
        if (hello == null) return close();
        if (!SUPPORTED_PROTOCOLS.includes(hello.protocol)) {
          return refuse('PROTOCOL', `this runtime speaks protocol ${SUPPORTED_PROTOCOLS.join(', ')}`, {supported: SUPPORTED_PROTOCOLS.slice()});
        }
        nc = handshake.bytesOf(hello.nc, handshake.CHALLENGE_BYTES);
        if (nc == null) return close();
        protocol = hello.protocol;
        ns = handshake.newChallenge();
        stage = 'auth';
        return write('P', {ns: ns.toString('base64'), ms: handshake.serverMac(secret, protocol, nc, ns).toString('base64')});
      }
      if (stage === 'auth') {
        const auth = parse(payload);
        const mc = auth != null ? handshake.bytesOf(auth.mc, 32) : null;
        if (mc == null || !handshake.macEquals(handshake.clientMac(secret, protocol, ns, nc), mc)) {
          return refuse('BAD_PROOF', 'the client\'s proof did not match');
        }
        if (draining) return refuse('SHUTTING_DOWN', 'the runtime is draining');
        if (auth.resume !== undefined) {
          const s = typeof(auth.resume) === 'string' ? registry._resume(auth.resume) : null;
          if (s == null) return refuse('RESUME_REFUSED', 'that session cannot be resumed');
          session = s;
        } else {
          if (registry._count() >= maxSessions) return refuse('BUSY', 'the session limit is reached');
          session = registry._create();
        }
        leavePreAuth();
        stage = 'welcomed';
        welcomed = setTimeout(close, welcomedDeadlineMs);
        if (typeof(welcomed.unref) === 'function') welcomed.unref();
        const token = registry._issue(session);
        session._attach(conn);
        return write('W', {session: session.id, resumeToken: token, runtimeVersion, maxToRuntime, maxToShim});
      }
      if (stage === 'welcomed') {
        const c = parse(payload);
        if (c == null || c.op !== 'client') return close();
        if (c.status !== 'ok') return ownRuntime('conditions-failed');
        const theirs = c.token == null ? null : handshake.bytesOf(c.token, 32);
        if (c.token != null && theirs == null) return close();
        // none chosen shares the daemon's; one chosen must be the daemon's
        const same = theirs == null || (daemonMac != null && handshake.macEquals(daemonMac, theirs));
        if (!same) return ownRuntime('token');
        clearTimeout(welcomed);
        session._setClient(c);
        stage = 'live';
        conn.settled = true;
        live.add(conn);
        write('C', {op: 'settled'});
        session._settled();
        if (!session._announced) {
          session._announced = true;
          registry._announce(session);
        }
        if (draining) write('C', {op: 'drain'});
        return undefined;
      }
      // live
      if (kind === 'C') {
        const c = parse(payload);
        if (c == null) return close();
        if (c.op === 'client') session._setClient(c);
        else if (c.op === 'replay') {
          if (!Array.isArray(c.entries) || c.entries.length > MAX_REPLAY) return close();
          if (!replayed) { replayed = true; session.emit('replay', c.entries); }
        } else if (c.op === 'bye') {
          const s = session;
          shut();
          s._end();
        }
        return undefined;   // an unknown op is ignored
      }
      let m;
      try {
        m = frames.decodeM(payload);
      } catch (e) {
        return close();
      }
      const r = lines.classify(m.line, m.header);
      if (!r.dispatch) {
        if (r.answer != null) writeM(null, r.answer);
        return undefined;
      }
      const header = r.seq !== undefined ? {seq: r.seq} : null;
      const s = session;
      let answered = false;
      const reply = (obj) => {
        if (answered || header == null || obj == null) return;
        answered = true;
        writeM(header, obj);
      };
      try {
        onMessage(s, r.message, reply);
      } catch (e) {
        reply({jsonrpc: '2.0', id: (r.message && r.message.id !== undefined) ? r.message.id : null, error: {code: -32603, message: 'internal error'}});
      }
      return undefined;
    }

    // a welcomed connection that can't be shared. A session opened by this
    // connection never opens; a resumed one that was open is detached, so its
    // reconnect window ends it (it can't be resumed into sharing).
    function ownRuntime(reason) {
      write('C', {op: 'own-runtime', reason});
      const s = session;
      shut();
      if (s == null) return;
      if (!s._announced) s._end();
      else if (s._conn === conn) s._detach();
    }
  }

  // every settled session is told to drain; new handshakes are refused
  function drain() {
    draining = true;
    for (const conn of live) conn.control({op: 'drain'});
  }

  return {
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => { server.removeListener('error', reject); resolve(); });
    }),
    drain,
    close: () => new Promise((resolve) => {
      registry.close();
      for (const s of all) s.destroy();
      server.close(() => resolve());
    }),
    server
  };
}

module.exports = {createListener, PRE_AUTH_MAX, PRE_AUTH_DEADLINE_MS, WELCOMED_DEADLINE_MS, READ_BEFORE_HELLO};
