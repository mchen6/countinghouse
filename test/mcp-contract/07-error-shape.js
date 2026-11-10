// The error-shape golden (logger-and-errors spec, step 1 (b)): the exact
// answer -- HTTP status and body -- on each entry path (HTTP invoke-action,
// MCP tools/call, MCP tasks/result) for a success and for each way a call
// fails (bad input, a module that throws, a module that calls back with an
// untyped and with a typed error, an unknown tool, a missing device, a key
// with no access, an unknown key, no key), in worker and single-thread mode.
//
// Step 1 moves every error site in lib/ to one class. This file is what says
// that move changed nothing a client sees; a step that means to change an
// answer (step 1 (d): bundled modules raise their own codes) regenerates the
// golden in the same commit and says so:
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
  const FORMS = ['module error returned', 'module error returned async', 'module error thrown', 'module error called back'];
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
