'use strict';
// The runtime's session listener (the shared-runtime design section 1, the
// wire contract, contract 2): the Rust shim's peer. It takes connections on
// the session socket, makes the handshake (the secret is never sent), and
// serves each authenticated connection as one session of the registry.
//
// Per connection, in order:
//   pre-auth  HELLO -> PROVE -> AUTH -> WELCOME or REFUSED. At most
//             preAuthMax at once. A new one past that evicts the oldest
//             already refused whose REFUSED is written out, else the oldest
//             whose bytes none have been read; if none is either, the new one is refused
//             (closed at once). One whose bytes were read -- a real shim's
//             handshake -- is never evicted, and a silent opener (a
//             read-only pipe instance, which can't write) never holds the
//             pool (F1-6, ruled).
//             Each has preAuthDeadlineMs to be welcomed, and at most 512
//             bytes are read before its HELLO is complete.
//   welcomed  the first `client` frame decides: a failed one, or one with a
//             malformed `credentials` key, is `own-runtime`
//             (conditions-failed); a token unlike the daemon's is
//             `own-runtime` (token); a pack credential unlike the runtime's
//             own, or one it lacks, is `own-runtime` (credential); the
//             connection then closes. Otherwise `settled`. An M before
//             settled closes.
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

// The client frame's credentials (ch-local's conditions child): absent, or
// an object of at most MAX_CREDENTIALS entries, each an environment
// variable's name and the standard base64 of a 32-byte keyed hash. -> a list
// of [name, Buffer], or MALFORMED.
const MAX_CREDENTIALS = 32;
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MALFORMED = Symbol('malformed');
function credentialsOf(v) {
  if (v === undefined) return [];
  if (v === null || typeof(v) !== 'object' || Array.isArray(v)) return MALFORMED;
  const names = Object.keys(v);
  if (names.length > MAX_CREDENTIALS) return MALFORMED;
  const out = [];
  for (const name of names) {
    if (!VARIABLE.test(name)) return MALFORMED;
    const mac = handshake.bytesOf(v[name], 32);
    if (mac == null) return MALFORMED;
    out.push([name, mac]);
  }
  return out;
}

// path: the Unix socket; secret: the 32 bytes; registry: createRegistry's;
// tokenMac(secret) -> Buffer | null: the daemon's token's keyed hash (null:
// the daemon has none); credentialMac(secret, name) -> Buffer | null: the
// keyed hash of the daemon's own value for a pack credential's variable
// (null: it has none); onMessage(s, message, reply): reply(obj) answers a
// request (ignored for a notification). maxSessions: past it a handshake is
// refused BUSY. maxWriteBuffer: a connection whose unwritten bytes pass it
// (a peer that doesn't read) is closed.
// onDrained(): called once, after a drain, when no live connection is left:
// each was closed by the runtime once its in-flight requests were answered
function createListener({path: socketPath, secret, registry, runtimeVersion, maxToRuntime, maxToShim, tokenMac = null, credentialMac = null, onMessage, onDrained = null,
  preAuthMax = PRE_AUTH_MAX, preAuthDeadlineMs = PRE_AUTH_DEADLINE_MS, welcomedDeadlineMs = WELCOMED_DEADLINE_MS, maxSessions = MAX_SESSIONS, maxWriteBuffer}) {
  for (const [name, v] of [['maxToRuntime', maxToRuntime], ['maxToShim', maxToShim]]) {
    if (!Number.isSafeInteger(v) || v < 0) throw new Error(`${name} ${v} is not a non-negative integer`);
  }
  const preAuth = [];          // connections not yet welcomed, oldest first
  const heard = new WeakSet(); // those of them whose bytes have been read
  const ending = new WeakSet(); // those of them already refused (shut)
  const closers = new WeakMap(); // each one's own close
  const all = new Set();
  const live = new Set();      // the conns of settled sessions
  const daemonMac = typeof(tokenMac) === 'function' ? tokenMac(secret) : null;
  const writeBound = Number.isSafeInteger(maxWriteBuffer) ? maxWriteBuffer : maxToShim + 1024 * 1024;
  let draining = false;
  let drainedTold = false;
  const checkDrained = () => {
    if (!draining || drainedTold || live.size > 0) return;
    drainedTold = true;
    if (typeof(onDrained) === 'function') onDrained();
  };

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
      ending.add(sock);
      decoder.stop();
      // a connection not yet welcomed stays in the pre-auth list until its
      // socket is gone (the close handler), so it still counts toward a full
      // pool
      clearTimeout(welcomed);
      if (!sock.destroyed) {
        sock.end();
        const t = setTimeout(() => sock.destroy(), 1000);
        if (typeof(t.unref) === 'function') t.unref();
      }
    };
    const close = () => { shut(); sock.destroy(); };
    const refuse = (code, message, extra) => { write('R', Object.assign({code, message}, extra || {})); shut(); };

    // (a full pool: the oldest one already refused whose REFUSED has gone
    // out -- nothing left to write -- is evicted, else the oldest silent one,
    // else this new one is refused -- F1-6, ruled)
    if (preAuth.length >= preAuthMax) {
      let k = preAuth.findIndex((s) => ending.has(s) && s.writableLength === 0);
      if (k === -1) k = preAuth.findIndex((s) => !heard.has(s));
      if (k === -1) { sock.destroy(); return; }
      closers.get(preAuth.splice(k, 1)[0])();
    }
    preAuth.push(sock);
    closers.set(sock, close);
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
      checkDrained();
      // a session that never settled ends with its connection; a settled
      // one is detached, for its reconnect window
      if (session != null && session._conn === conn) {
        if (session._announced === true) session._detach();
        else session._end('unsettled');
      }
    });
    sock.on('error', () => {});

    // the connection, as the session sees it: only once settled
    const conn = {
      settled: false,
      inFlight: 0,
      // during a drain, the runtime closes a settled connection once its
      // in-flight requests are answered (the shim relays answers until then)
      closeIfDrained: () => { if (draining && conn.settled && conn.inFlight === 0) shut(); },
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
      heard.add(sock);
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
        // the pack credentials the client's environment chooses (ch-local's
        // conditions child names them from the installed packs): spliced in
        // by the shim unchecked, so a malformed set is a failed check, never
        // a share; one unlike the daemon's own, or that it has none of, is a
        // session of its own
        const creds = credentialsOf(c.credentials);
        if (creds === MALFORMED) return ownRuntime('conditions-failed');
        if (!same) return ownRuntime('token');
        if (!creds.every(([name, mac]) => {
          const mine = typeof(credentialMac) === 'function' ? credentialMac(secret, name) : null;
          return mine != null && handshake.macEquals(mine, mac);
        })) return ownRuntime('credential');
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
        if (draining) { write('C', {op: 'drain'}); conn.closeIfDrained(); }
        return undefined;
      }
      // live
      if (kind === 'C') {
        const c = parse(payload);
        if (c == null) return close();
        if (c.op === 'client') session._setClient(c);
        else if (c.op === 'replay') {
          if (!Array.isArray(c.entries) || c.entries.length > MAX_REPLAY) return close();
          // (one per connection, answered; a second is no protocol: closed,
          // so the shim attaches again rather than wait for an answer)
          if (replayed) return close();
          replayed = true;
          session.emit('replay', c.entries);
        } else if (c.op === 'bye') {
          const s = session;
          shut();
          s._end('bye');
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
      if (header != null) conn.inFlight += 1;
      const reply = (obj) => {
        if (answered || header == null || obj == null) return;
        answered = true;
        writeM(header, obj);
        conn.inFlight -= 1;
        conn.closeIfDrained();
      };
      // a cancelled call (M19): no answer will come, so the shim is told to
      // forget its seq (the control op `cancelled`; an older shim ignores an
      // op it doesn't know), and the request no longer holds a drain
      reply.cancel = () => {
        if (answered || header == null) return;
        answered = true;
        if (conn.settled) write('C', {op: 'cancelled', seq: header.seq});
        conn.inFlight -= 1;
        conn.closeIfDrained();
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
      if (!s._announced) s._end('unsettled');
      else if (s._conn === conn) s._detach();
    }
  }

  // the idle stop (ch-local daemon): drains only if no session is held
  // (registry.idle()) and no connection is still in pre-auth, in one tick,
  // so nothing can arrive between the check and the drain -> whether it did
  function drainIfIdle() {
    if (!registry.idle() || preAuth.length > 0) return false;
    drain();
    return true;
  }

  // every settled session is told to drain; new handshakes are refused
  function drain() {
    draining = true;
    for (const conn of [...live]) { conn.control({op: 'drain'}); conn.closeIfDrained(); }
    checkDrained();
  }

  return {
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => { server.removeListener('error', reject); resolve(); });
    }),
    drain,
    drainIfIdle,
    close: () => new Promise((resolve) => {
      registry.close();
      for (const s of all) s.destroy();
      server.close(() => resolve());
    }),
    server
  };
}

module.exports = {createListener, MAX_SESSIONS, PRE_AUTH_MAX, PRE_AUTH_DEADLINE_MS, WELCOMED_DEADLINE_MS, READ_BEFORE_HELLO};
