'use strict';
// A minimal shim for the session-transport tests: connects to a listener's
// socket, makes the handshake from the given secret, and reads frames. It
// speaks contract 2 as the Rust shim does, and nothing more.
const net = require('net');
const frames = require('../../../lib/session-transport/frames');
const handshake = require('../../../lib/session-transport/handshake');

function connect(socketPath) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    const got = [];
    const waiters = [];
    let closed = false;
    const decoder = frames.createDecoder({caps: {M: 1 << 30}, onFrame: (kind, payload) => {
      got.push({kind, payload});
      for (const w of waiters.splice(0)) w();
    }, onError: () => sock.destroy()});
    sock.on('data', (c) => decoder.push(c));
    sock.on('close', () => { closed = true; for (const w of waiters.splice(0)) w(); });
    sock.on('error', () => {});
    const c = {
      sock,
      got,
      closed: () => closed,
      send: (kind, payload) => sock.write(frames.encode(kind, typeof(payload) === 'string' || Buffer.isBuffer(payload) ? payload : JSON.stringify(payload))),
      raw: (buf) => sock.write(buf),
      // the next frame of `kind` not yet taken (any kind when null), or null
      // if the connection closes first or `ms` passes
      next: (kind = null, ms = 3000) => new Promise((res) => {
        const until = Date.now() + ms;
        let done = false;
        const finish = (v) => { done = true; res(v); };
        // a look left over from a wait that already ended takes nothing
        const look = () => {
          if (done) return undefined;
          const i = got.findIndex((f) => kind == null || f.kind === kind);
          if (i >= 0) return finish(got.splice(i, 1)[0]);
          if (closed || Date.now() > until) return finish(null);
          waiters.push(look);
          setTimeout(look, Math.max(0, until - Date.now()) + 1);
          return undefined;
        };
        look();
      }),
      json: async(kind, ms) => { const f = await c.next(kind, ms); return f == null ? null : JSON.parse(f.payload.toString('utf8')); },
      end: () => sock.destroy()
    };
    sock.once('connect', () => resolve(c));
    sock.once('error', reject);
  });
}

// connect, HELLO, check PROVE, AUTH -> {c, welcome} or {c, refused}
async function attach(socketPath, secret, {protocol = 1, resume, wrongSecret} = {}) {
  const c = await connect(socketPath);
  const nc = handshake.newChallenge();
  c.send('H', {protocol, nc: nc.toString('base64')});
  const prove = await c.json('P');
  if (prove == null) return {c, refused: await c.json('R', 200)};
  const ns = Buffer.from(prove.ns, 'base64');
  const ok = handshake.macEquals(handshake.serverMac(secret, protocol, nc, ns), Buffer.from(prove.ms, 'base64'));
  const key = wrongSecret != null ? wrongSecret : secret;
  const auth = {mc: handshake.clientMac(key, protocol, ns, nc).toString('base64')};
  if (resume != null) auth.resume = resume;
  c.send('A', auth);
  const f = await c.next(null);
  if (f == null) return {c, proveOk: ok};
  const body = JSON.parse(f.payload.toString('utf8'));
  return f.kind === 'W' ? {c, welcome: body, proveOk: ok} : {c, refused: body, proveOk: ok};
}

// attach, then the first `client` frame and wait for settled
async function session(socketPath, secret, client = {status: 'ok', conditions: 'yes', repo: null, token: null}, opts = {}) {
  const a = await attach(socketPath, secret, opts);
  if (a.welcome == null) return a;
  a.c.send('C', Object.assign({op: 'client'}, client));
  a.settled = await a.c.json('C');
  return a;
}

const message = (c, header, line) => c.send('M', frames.encodeM(header, Buffer.from(line, 'utf8')));
const readM = async(c, ms) => {
  const f = await c.next('M', ms);
  return f == null ? null : frames.decodeM(f.payload);
};

module.exports = {connect, attach, session, message, readM};
