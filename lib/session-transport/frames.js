'use strict';
// The session socket's frames (docs/superpowers/specs/
// 2026-11-15-shared-runtime-design.md section 1, contract 2): one kind byte
// (an ASCII letter), a 4-byte big-endian payload length, the payload. A
// receiver checks the length against the kind's cap before it reads the
// payload, and stops at an over-cap length or an unknown kind.
//
// An M payload is a 2-byte big-endian header length, the header JSON object
// (none when the length is 0), then one line's bytes. The header carries
// only `seq`, a positive safe integer the shim assigns to a request or a
// batch and the runtime echoes on its answer.
const CONTRACT = 2;
const PROTOCOL = 1;

// Caps on each kind's payload. HELLO's whole frame (5 + 507) fits the 512
// bytes read from a connection before its HELLO is complete. M's caps come
// from WELCOME (maxToRuntime, maxToShim), per connection.
const CAPS = Object.freeze({H: 507, P: 4096, A: 4096, W: 4096, R: 4096, C: 65536});
const KINDS = new Set(['H', 'P', 'A', 'W', 'R', 'C', 'M']);
const HEAD = 5;

function encode(kind, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const head = Buffer.alloc(HEAD);
  head.write(kind, 0, 'ascii');
  head.writeUInt32BE(body.length, 1);
  return Buffer.concat([head, body]);
}

// header: {seq} or null; line: the line's bytes
function encodeM(header, line) {
  const h = header == null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(header), 'utf8');
  if (h.length > 0xffff) throw new Error('M header too long');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(h.length, 0);
  return Buffer.concat([len, h, Buffer.isBuffer(line) ? line : Buffer.from(String(line), 'utf8')]);
}

// An M payload -> {header: {seq} | null, line: Buffer}. Throws on a malformed
// one, which closes the connection.
function decodeM(payload) {
  if (!Buffer.isBuffer(payload) || payload.length < 2) throw new Error('M payload under 2 bytes');
  const hlen = payload.readUInt16BE(0);
  if (hlen > payload.length - 2) throw new Error('M header longer than the payload');
  let header = null;
  if (hlen > 0) {
    try {
      header = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(payload.subarray(2, 2 + hlen)));
    } catch (e) {
      throw new Error('M header is not JSON');
    }
    if (header == null || typeof(header) !== 'object' || Array.isArray(header)) throw new Error('M header is not a JSON object');
    if (header.seq !== undefined && !(Number.isSafeInteger(header.seq) && header.seq > 0)) throw new Error('M header seq is not a positive integer');
  }
  return {header, line: payload.subarray(2 + hlen)};
}

// An incremental reader of frames. caps: per-kind payload caps added to (or
// overriding) CAPS, M's from WELCOME. onFrame(kind, payload); onError(why)
// is called once, and nothing is read after it.
function createDecoder({caps = {}, onFrame, onError}) {
  const limits = Object.assign({}, CAPS, caps);
  let chunks = [];
  let buffered = 0;
  let failed = false;
  let want = null;   // {kind, length} once a head is read

  const take = (n) => {
    const all = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, buffered);
    const out = all.subarray(0, n);
    const rest = all.subarray(n);
    chunks = rest.length > 0 ? [rest] : [];
    buffered = rest.length;
    return out;
  };
  const fail = (why) => {
    failed = true;
    chunks = [];
    buffered = 0;
    onError(why);
  };

  function push(chunk) {
    if (failed || chunk == null || chunk.length === 0) return;
    chunks.push(chunk);
    buffered += chunk.length;
    for (;;) {
      if (want == null) {
        if (buffered < HEAD) return;
        const head = Buffer.from(take(HEAD));
        const kind = String.fromCharCode(head[0]);
        const length = head.readUInt32BE(1);
        if (!KINDS.has(kind)) return fail(`an unknown frame kind 0x${head[0].toString(16)}`);
        const cap = limits[kind];
        if (cap == null || length > cap) return fail(`a ${kind} frame of ${length} bytes, over its cap of ${cap}`);
        want = {kind, length};
      }
      if (buffered < want.length) return;
      const payload = Buffer.from(take(want.length));
      const kind = want.kind;
      want = null;
      onFrame(kind, payload);
      if (failed) return;
    }
  }

  return {push, failed: () => failed};
}

module.exports = {CONTRACT, PROTOCOL, CAPS, encode, encodeM, decodeM, createDecoder};
