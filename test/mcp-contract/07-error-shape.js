// The error-shape golden (logger-and-errors spec, step 1 (b)): the exact
// answer -- HTTP status and body -- on each entry path (HTTP invoke-action,
// MCP tools/call, MCP tasks/result) for a success and for each way a call
// fails (bad input, a module that throws, a module that calls back with an
// untyped and with a typed error, an unknown tool, a missing device, a key
// with no access, an unknown key, no key), in worker and single-thread mode.
//
// The golden is the recorded contract, and it changes only on purpose: a
// commit that means to change an answer regenerates it in the same commit,
// and its PR lists every changed answer (the user, 2026-11-10: there is no
// client yet, so the old shape is not preserved; step 1 (d2) dropped
// `topic`, for one):
//   node test/mcp-contract/capture-error-shape.js
//
// One recorded answer is wrong on purpose and stays until R2-1 Task 5: an
// unknown key is echoed in its error text (see test/helpers/error-shape-cases.js).
//
// It also checks the recording against lib/error-catalogue.js, whose
// httpStatus and mcpCode record today's behaviour: every coded error answer
// on invoke-action has its code's httpStatus, and every coded error on
// tools/call is a tool result (mcpCode null), not a JSON-RPC error.
const assert = require('assert');
const path   = require('path');
const {startServer, stopServer} = require('../helpers/sandbox-server');
const {runCases, MODES} = require('../helpers/error-shape-cases');
const {CODES} = require('../../lib/error-catalogue');
const {toolErrorCode} = require('../helpers/tool-result');

const ROOT    = path.join(__dirname, '..', '..');
const GOLDEN  = require('./error-shape.golden.json');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'error-shape-module');
const AUTH    = path.join(__dirname, 'error-shape-auth.json');
const PORTS   = {worker: 9656, 'single-thread': 9657};


describe('mcp-contract 07: error bodies are byte-identical to the golden (logger-design step 1)', function() {
  this.timeout(180000);

  it('records the same modes as the golden', () => {
    assert.deepStrictEqual(Object.keys(GOLDEN), Object.keys(MODES));
  });

  for (const mode of Object.keys(MODES)) {
    describe(`${mode} mode`, () => {
      let server = null;
      let got = null;
      before(async () => {
        server = await startServer(PORTS[mode], MODES[mode].flags.concat(['--authConfigPath', AUTH, '--loadModule', FIXTURE]));
        got = await runCases(PORTS[mode], MODES[mode].tasks);
      });
      after(() => stopServer(server));

      it('answers every case exactly as the golden records', () => {
        assert.deepStrictEqual(Object.keys(got), Object.keys(GOLDEN[mode]));
        for (const name of Object.keys(GOLDEN[mode])) {
          assert.deepStrictEqual(got[name], GOLDEN[mode][name], name);
        }
      });
    });
  }

  // Step 1 (d1), the user's preference: a handler may hand back its own
  // error (ctx.error) by returning it -- from a plain function or an async
  // one -- as well as by throwing it or calling back with it. All four are
  // the same answer, and it carries the module's code. A plain object that
  // only looks like an error is a result.
  const FORMS = ['module error returned', 'module error returned async', 'module error thrown', 'module error called back',
    'module error thrown sync', 'plain error with a module code'];
  const PATHS = ['http invoke-action', 'mcp tools/call', 'mcp tasks/result'];

  it('gives the same answer for a module error returned, returned async, thrown or called back', () => {
    let compared = 0;
    for (const mode of Object.keys(GOLDEN)) {
      for (const p of PATHS) {
        const answers = FORMS.map((f) => GOLDEN[mode][`${p} / ${f}`]).filter((a) => a !== undefined);
        if (answers.length === 0) continue;
        assert.strictEqual(answers.length, FORMS.length, `${mode} / ${p}`);
        for (let i = 1; i < answers.length; i++) assert.deepStrictEqual(answers[i], answers[0], `${mode} / ${p} / ${FORMS[i]}`);
        compared++;
      }
    }
    assert.ok(compared >= 5, `premise: compared ${compared} path/mode pairs`);
  });

  it('carries the module\'s own code for a module error, and its message where the message crosses', () => {
    for (const mode of Object.keys(GOLDEN)) {
      const http = GOLDEN[mode]['http invoke-action / module error returned'];
      assert.strictEqual(http.body.code, 'SHAPE_REJECTED', `${mode}: ${JSON.stringify(http)}`);
      const call = GOLDEN[mode]['mcp tools/call / module error returned'];
      assert.strictEqual(toolErrorCode(call.body.result), 'SHAPE_REJECTED', `${mode}: ${JSON.stringify(call)}`);
    }
    assert.strictEqual(GOLDEN['single-thread']['http invoke-action / module error returned'].body.message, 'SHAPE_REJECTED: shape probe');
  });

  // Step 1 (d2): the worker reply carries a module's error whole (code,
  // message, origin), so worker mode answers it exactly as single-thread.
  it('answers a module error in worker mode exactly as in single-thread mode', () => {
    for (const f of FORMS.concat(['module typed error'])) {
      for (const p of ['http invoke-action', 'mcp tools/call']) {
        const w = GOLDEN.worker[`${p} / ${f}`];
        const s = GOLDEN['single-thread'][`${p} / ${f}`];
        assert.ok(w !== undefined && s !== undefined, `premise: ${p} / ${f} in both modes`);
        assert.deepStrictEqual(w, s, `${p} / ${f}`);
      }
    }
    assert.strictEqual(GOLDEN.worker['http invoke-action / module error returned'].body.message, 'SHAPE_REJECTED: shape probe');
  });

  // §5.1: a plain Error's code is the module's only when it looks like one
  // and is not someone else's: a system error's (errno/syscall), Node's
  // (ERR_), or a network or TLS library's (an errno name, UND_ERR_, X509).
  it('takes a plain Error\'s code as the module\'s only when it is not a system or Node code', () => {
    for (const mode of Object.keys(GOLDEN)) {
      assert.strictEqual(GOLDEN[mode]['http invoke-action / module typed error'].body.code, 'SHAPE_OFFLINE', mode);
      for (const f of ['plain error with a system code', 'plain error with a Node code', 'plain error with a network code']) {
        const a = GOLDEN[mode][`http invoke-action / ${f}`];
        assert.strictEqual(a.body.code, 'DEVICE_INVOKE_EXCEPTION', `${mode} / ${f}: ${JSON.stringify(a)}`);
      }
    }
  });

  // /code-review medium on c8: with nothing to say, the message is the
  // catalogue's text alone (no dangling ': '), the same in either mode.
  it('answers a message-less crash with the catalogue text alone, alike in either mode', () => {
    for (const f of ['thrown null', 'rejected with nothing', 'thrown Error with no message']) {
      const seen = Object.keys(GOLDEN).map((mode) => GOLDEN[mode][`http invoke-action / ${f}`].body.message);
      seen.forEach((m) => assert.ok(!/:\s*$/.test(m), `${f}: ${JSON.stringify(seen)}`));
      assert.strictEqual(new Set(seen).size, 1, `${f}: ${JSON.stringify(seen)}`);
    }
  });

  // Review of #37: a thrown value that is not an Error (null, nothing, a
  // plain object with a code) is a crash, answered at once in either mode --
  // not left unanswered (DEVICE_NOT_RESPONDING), and not a typed module error.
  it('answers a thrown non-Error as a crash, at once', () => {
    for (const mode of Object.keys(GOLDEN)) {
      for (const f of ['thrown null', 'rejected with nothing', 'thrown plain object with a code']) {
        const a = GOLDEN[mode][`http invoke-action / ${f}`];
        assert.ok(a !== undefined, `premise: ${mode} / ${f} in the golden`);
        assert.strictEqual(a.body.code, 'DEVICE_INVOKE_EXCEPTION', `${mode} / ${f}: ${JSON.stringify(a)}`);
      }
    }
  });

  // Review of c9: reading a thrown value never stops the answer, and a
  // callback failure's object message is still shown where an untyped
  // callback message is shown at all: single-thread mode (and REST in it).
  // Over the worker hop an untyped failure is re-wrapped by its code alone
  // (lib/handler-ctx.js, CountinghouseError.fromReply), so worker mode
  // answers the catalogue's text, exactly as for a string message.
  it('answers a thrown value whose properties throw as a crash, at once', () => {
    for (const mode of Object.keys(GOLDEN)) {
      const a = GOLDEN[mode]['http invoke-action / thrown value with unreadable properties'];
      assert.ok(a !== undefined, `premise: ${mode} in the golden`);
      assert.strictEqual(a.body.code, 'DEVICE_INVOKE_EXCEPTION', `${mode}: ${JSON.stringify(a)}`);
    }
  });

  it('keeps a callback failure\'s object message as JSON in single-thread mode, and treats it as a string message in worker mode', () => {
    const st = GOLDEN['single-thread']['http invoke-action / callback error with an object message'];
    assert.ok(st !== undefined, 'premise: single-thread in the golden');
    assert.strictEqual(st.body.code, 'DEVICE_INVOKE_FAIL', JSON.stringify(st));
    assert.ok(st.body.message.includes('{"reason":"quota"}'), JSON.stringify(st));
    const w = GOLDEN.worker['http invoke-action / callback error with an object message'];
    const wPlain = GOLDEN.worker['http invoke-action / module callback error'];
    assert.ok(w !== undefined && wPlain !== undefined, 'premise: worker in the golden');
    assert.strictEqual(w.body.code, 'DEVICE_INVOKE_FAIL', JSON.stringify(w));
    assert.deepStrictEqual(w.body, wPlain.body);
  });

  // Review of c10: a fault keeps what it can read, every field as text; a
  // message that cannot be rendered is still answered; a blank one is none.
  it('keeps a fault\'s readable fields and renders each as text', () => {
    for (const mode of Object.keys(GOLDEN)) {
      const g = GOLDEN[mode]['http invoke-action / thrown Error whose stack getter throws'];
      assert.ok(g !== undefined, `premise: ${mode} in the golden`);
      assert.strictEqual(g.body.code, 'DEVICE_INVOKE_EXCEPTION', `${mode}: ${JSON.stringify(g)}`);
      assert.strictEqual(g.body.fault.message, 'db down', `${mode}: ${JSON.stringify(g)}`);
      assert.strictEqual(g.body.fault.name, 'Error', `${mode}: ${JSON.stringify(g)}`);
      const u = GOLDEN[mode]['http invoke-action / thrown Error with an unrenderable stack'];
      assert.strictEqual(u.body.code, 'DEVICE_INVOKE_EXCEPTION', `${mode}: ${JSON.stringify(u)}`);
      assert.strictEqual(u.body.fault.message, 'x', `${mode}: ${JSON.stringify(u)}`);
      assert.ok(typeof(u.body.fault.stack) === 'string', `${mode}: ${JSON.stringify(u)}`);
    }
  });

  it('answers a callback failure whose message cannot be rendered, and one whose message is blank', () => {
    for (const mode of Object.keys(GOLDEN)) {
      const c = GOLDEN[mode]['http invoke-action / callback error with a circular message'];
      assert.ok(c !== undefined, `premise: ${mode} in the golden`);
      assert.strictEqual(c.body.code, 'DEVICE_INVOKE_FAIL', `${mode}: ${JSON.stringify(c)}`);
      const b = GOLDEN[mode]['http invoke-action / callback error with a blank message'];
      assert.strictEqual(b.body.code, 'DEVICE_INVOKE_FAIL', `${mode}: ${JSON.stringify(b)}`);
      assert.ok(!/:\s*$/.test(b.body.message), `${mode}: ${JSON.stringify(b)}`);
    }
    const st = GOLDEN['single-thread']['http invoke-action / callback error with a circular message'];
    assert.ok(st.body.message.endsWith(': [unrenderable value]'), JSON.stringify(st));
  });

  // Step 1 (d2): no module-visible error classes, and no `topic` in an answer.
  it('gives modules no old error globals, in either mode', () => {
    for (const mode of Object.keys(GOLDEN)) {
      const a = GOLDEN[mode]['http invoke-action / old globals'];
      const body = JSON.stringify(a.body);
      assert.strictEqual(a.status, 200, `${mode}: ${body}`);
      assert.ok(body.includes('"deviceError":"undefined"') && body.includes('"chError":"undefined"'), `${mode}: ${body}`);
    }
  });

  it('carries no `topic` in any answer', () => {
    for (const mode of Object.keys(GOLDEN)) {
      for (const [name, a] of Object.entries(GOLDEN[mode])) {
        assert.ok(!JSON.stringify(a).includes('"topic"'), `${mode} / ${name}: ${JSON.stringify(a).slice(0, 200)}`);
      }
    }
  });

  it('treats a returned object that merely looks like an error as a result', () => {
    for (const mode of Object.keys(GOLDEN)) {
      const a = GOLDEN[mode]['http invoke-action / lookalike returned'];
      assert.notStrictEqual(a.body.code, 'SHAPE_REJECTED', `${mode}: ${JSON.stringify(a)}`);
    }
  });

  it('agrees with the catalogue: invoke-action answers each code with its httpStatus', () => {
    let checked = 0;
    for (const mode of Object.keys(GOLDEN)) {
      for (const [name, a] of Object.entries(GOLDEN[mode])) {
        if (!name.startsWith('http invoke-action') || a.body == null || typeof(a.body.code) !== 'string') continue;
        if (!Object.prototype.hasOwnProperty.call(CODES, a.body.code)) continue;
        assert.strictEqual(a.status, CODES[a.body.code].httpStatus, `${mode} / ${name}: ${a.body.code}`);
        checked++;
      }
    }
    assert.ok(checked > 0, 'premise: some coded answers');
  });

  it('agrees with the catalogue: a coded error on tools/call is a tool result, so mcpCode is null', () => {
    let checked = 0;
    for (const mode of Object.keys(GOLDEN)) {
      for (const [name, a] of Object.entries(GOLDEN[mode])) {
        if (!name.startsWith('mcp tools/call')) continue;
        const code = toolErrorCode(a.body.result);
        if (code == null || !Object.prototype.hasOwnProperty.call(CODES, code)) continue;
        assert.strictEqual(a.body.error, undefined, `${mode} / ${name}`);
        assert.strictEqual(CODES[code].mcpCode, null, `${mode} / ${name}: ${code}`);
        checked++;
      }
    }
    assert.ok(checked > 0, 'premise: some coded tool results');
  });
});
