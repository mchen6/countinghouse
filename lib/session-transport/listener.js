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

const TOO_LARGE = (id) => ({jsonrpc: '2.0', id: id === undefined ? null : id, error: {code: -32603, message: 'the answer is larger than this connection carries',
  data: {'countinghouse/code': 'OUTPUT_TOO_LARGE', retryable: false}}});

// path: the Unix socket; secret: the 32 bytes; registry: createRegistry's;
// tokenMac(secret) -> Buffer | null: the daemon's token's keyed hash (null:
// the daemon has none); onMessage(s, message, reply): reply(obj) answers a
// request (ignored for a notification).
function createListener({path: socketPath, secret, registry, runtimeVersion, maxToRuntime, maxToShim, tokenMac = null, onMessage,
  preAuthMax = PRE_AUTH_MAX, preAuthDeadlineMs = PRE_AUTH_DEADLINE_MS}) {
  const preAuth = [];          // connections not yet welcomed, oldest first
  const all = new Set();
  const daemonMac = typeof(tokenMac) === 'function' ? tokenMac(secret) : null;

  const server = net.createServer((sock) => {
    all.add(sock);
    sock.on('close', () => all.delete(sock));
    serve(sock);
  });

  function serve(sock) {
    let stage = 'hello';
    let bytesBeforeHello = 0;
    let nc = null;
    let ns = null;
    let protocol = null;
    let session = null;
    const pending = {settledFirst: false};

    const close = () => { sock.destroy(); };
    const write = (kind, obj) => { if (!sock.destroyed) sock.write(frames.encode(kind, typeof(obj) === 'string' ? obj : JSON.stringify(obj))); };
    const refuse = (code, message, extra) => { write('R', Object.assign({code, message}, extra || {})); sock.end(); };

    preAuth.push(sock);
    if (preAuth.length > preAuthMax) {
      const oldest = preAuth.shift();
      oldest.destroy();
    }
    const deadline = setTimeout(close, preAuthDeadlineMs);
    if (typeof(deadline.unref) === 'function') deadline.unref();
    const leavePreAuth = () => {
      clearTimeout(deadline);
      const i = preAuth.indexOf(sock);
      if (i >= 0) preAuth.splice(i, 1);
    };
    sock.on('close', () => {
      leavePreAuth();
      if (session != null && session._conn === conn) session._detach();
    });
    sock.on('error', () => {});

    // the connection, as the session sees it
    const conn = {
      notify: (obj) => writeM(null, obj),
      control: (obj) => write('C', obj),
      close: () => { if (!sock.destroyed) sock.end(); }
    };

    function writeM(header, obj) {
      if (sock.destroyed) return;
      let line = Buffer.from(JSON.stringify(obj), 'utf8');
      if (line.length + 2 + 64 > maxToShim) {
        if (header == null) return;      // a notification too large to carry: dropped
        line = Buffer.from(JSON.stringify(TOO_LARGE(obj != null ? obj.id : null)), 'utf8');
      }
      sock.write(frames.encode('M', frames.encodeM(header, line)));
    }

    const decoder = frames.createDecoder({caps: {M: maxToRuntime}, onFrame, onError: close});
    sock.on('data', (chunk) => {
      if (stage === 'hello') {
        bytesBeforeHello += chunk.length;
        if (bytesBeforeHello > READ_BEFORE_HELLO) {
          // a complete HELLO within the first 512 bytes has been seen
          // already (stage moved on), so this is still before it
          return close();
        }
      }
      decoder.push(chunk);
    });

    function parse(payload) {
      try {
        const o = JSON.parse(payload.toString('utf8'));
        return (o != null && typeof(o) === 'object' && !Array.isArray(o)) ? o : null;
      } catch (e) {
        return null;
      }
    }

    function onFrame(kind, payload) {
      if (stage === 'hello') {
        if (kind !== 'H') return close();
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
        if (kind !== 'A') return close();
        const auth = parse(payload);
        const mc = auth != null ? handshake.bytesOf(auth.mc, 32) : null;
        if (mc == null || !handshake.macEquals(handshake.clientMac(secret, protocol, ns, nc), mc)) {
          return refuse('BAD_PROOF', 'the client\'s proof did not match');
        }
        if (auth.resume !== undefined) {
          const s = typeof(auth.resume) === 'string' ? registry._resume(auth.resume) : null;
          if (s == null) return refuse('RESUME_REFUSED', 'that session cannot be resumed');
          session = s;
        } else {
          session = registry._create();
        }
        leavePreAuth();
        stage = 'welcomed';
        const token = registry._issue(session);
        session._attach(conn);
        return write('W', {session: session.id, resumeToken: token, runtimeVersion, maxToRuntime, maxToShim});
      }
      if (stage === 'welcomed') {
        if (kind !== 'C') return close();
        const c = parse(payload);
        if (c == null || c.op !== 'client') return close();
        if (c.status !== 'ok') {
          write('C', {op: 'own-runtime', reason: 'conditions-failed'});
          return endUnsettled();
        }
        const theirs = c.token == null ? null : handshake.bytesOf(c.token, 32);
        if (c.token != null && theirs == null) return close();
        const same = (theirs == null && daemonMac == null) || (theirs != null && daemonMac != null && handshake.macEquals(daemonMac, theirs)) ||
          (theirs == null && daemonMac != null);
        if (!same) {
          write('C', {op: 'own-runtime', reason: 'token'});
          return endUnsettled();
        }
        session._setClient(c);
        stage = 'live';
        write('C', {op: 'settled'});
        if (!pending.settledFirst && !session._announced) {
          session._announced = true;
          registry._announce(session);
        }
        pending.settledFirst = true;
        return undefined;
      }
      // live
      if (kind === 'C') {
        const c = parse(payload);
        if (c == null) return close();
        if (c.op === 'client') session._setClient(c);
        else if (c.op === 'replay') { if (Array.isArray(c.entries)) session.emit('replay', c.entries); }
        else if (c.op === 'bye') session._end();
        return undefined;   // an unknown op is ignored
      }
      if (kind !== 'M') return close();
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
      let answered = false;
      const reply = (obj) => {
        if (answered || header == null || obj == null) return;
        answered = true;
        writeM(header, obj);
      };
      try {
        onMessage(session, r.message, reply);
      } catch (e) {
        reply({jsonrpc: '2.0', id: (r.message && r.message.id !== undefined) ? r.message.id : null, error: {code: -32603, message: 'internal error'}});
      }
      return undefined;
    }

    // a welcomed connection that can't be shared: its session never opened
    function endUnsettled() {
      const s = session;
      session = null;
      if (s != null && !s._announced) s._end();
      sock.end();
    }
  }

  return {
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => { server.removeListener('error', reject); resolve(); });
    }),
    close: () => new Promise((resolve) => {
      registry.close();
      for (const s of all) s.destroy();
      server.close(() => resolve());
    }),
    server
  };
}

module.exports = {createListener, PRE_AUTH_MAX, PRE_AUTH_DEADLINE_MS, READ_BEFORE_HELLO};
