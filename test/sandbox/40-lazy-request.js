// When CHUtil.request's library, postman-request (about 240 files), loads.
// It used to load on first use in every mode (reviewer, 2026-11-12: a fifth
// of every worker's boot, and a module in the current format rarely uses
// it). Since #194's PR 1 nothing of the runtime's loads after a worker's
// lockdown, so (ruling (b), the spec's Revision 6 item 11):
// - a worker whose module declares `net` loads it at set-options, before
//   the lockdown, under enforce and audit;
// - a worker whose module declares no `net`: under enforce every request is
//   refused before the library is reached, so it never loads; under audit
//   the request is allowed and reported, and the library loads then, after
//   the lockdown (audit isn't a boundary; the request carries only the
//   module's own options);
// - single-thread mode has no lockdown: still on first use.
// The lockdown's host check refuses an undeclared host either way.
//
// The local stdio profile: no Redis, no fixed port. The stand-in is an
// ephemeral loopback server; the undeclared host is under .invalid and only
// asked for under enforce, which refuses it before any lookup.
const assert = require('assert');
const fs = require('fs');
const {startStandIn} = require('../helpers/lazy-net-stand-in');
const os = require('os');
const path = require('path');
const {spawn} = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const ENTRY = path.join(ROOT, 'bin', 'countinghouse-stdio.js');
const WITH_NET = path.join(ROOT, 'test', 'fixtures', 'lazy-net-probe');
const NO_NET = path.join(ROOT, 'test', 'fixtures', 'lazy-net-probe-no-net');
const UNDECLARED = 'http://lazy-40.invalid/';
const KEY = 'sandbox-40-key';

function start(home, extra, MODULE) {
  // Every device for one key, as test/stdio/02 does, so the module's tool is listed.
  const auth = path.join(home, 'auth.json');
  fs.writeFileSync(auth, JSON.stringify({[KEY]: {userName: 'sandbox-40', devices: ['*']}}));
  // The operator approves the declared net permission (127.0.0.1): under
  // enforce an unapproved declaration is granted nothing.
  const policy = path.join(home, 'policy.json');
  fs.writeFileSync(policy, JSON.stringify({modules: {[path.basename(MODULE)]: {approve: 'as-declared'}}}));
  const child = spawn(process.execPath, [ENTRY, ...extra, '--authConfigPath', auth, '--modulePolicy', policy, '--store', 'local', '--storePath', path.join(home, 'store'),
    '--moduleDataPath', path.join(home, 'module_data'), '--modulePath', path.join(home, 'modules'), '--loadModule', MODULE],
  {env: {...process.env, COUNTINGHOUSE_API_KEY: KEY}, stdio: ['pipe', 'pipe', 'pipe']});
  const io = {child, replies: [], pending: '', err: '', waiters: new Set()};
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  // Whole lines only: a reply may span two reads.
  child.stdout.on('data', (d) => {
    io.pending += d;
    const lines = io.pending.split('\n');
    io.pending = lines.pop();
    for (const l of lines) if (l !== '') io.replies.push(JSON.parse(l));
    io.waiters.forEach((w) => w());
  });
  child.stderr.on('data', (d) => { io.err += d; });
  return io;
}

function request(io, message, timeoutMs = 30000) {
  io.child.stdin.write(`${JSON.stringify(message)}\n`);
  return new Promise((resolve, reject) => {
    const check = () => {
      const found = io.replies.find((r) => r.id === message.id);
      if (found) { clearTimeout(timer); io.waiters.delete(check); resolve(found); }
    };
    const timer = setTimeout(() => { io.waiters.delete(check); reject(new Error(`no answer to ${message.method}: ${io.err.slice(-3000)}`)); }, timeoutMs);
    io.waiters.add(check);
    check();
  });
}

// [where, flags, mode, module, loaded at boot]
[
  ['the worker under enforce, net declared', ['--workerThread', '--moduleSandbox', 'enforce'], 'enforce', WITH_NET, true],
  ['the worker under audit, net declared', ['--workerThread', '--moduleSandbox', 'audit'], 'audit', WITH_NET, true],
  ['single-thread mode', ['--no-workerThread'], 'off', WITH_NET, false],
  ['the worker under enforce, no net declared', ['--workerThread', '--moduleSandbox', 'enforce'], 'enforce', NO_NET, false],
  ['the worker under audit, no net declared', ['--workerThread', '--moduleSandbox', 'audit'], 'audit', NO_NET, false]
].forEach(([where, flags, mode, MODULE, atBoot]) => {
  const refuses = (mode === 'enforce');
  const declares = (MODULE === WITH_NET);
  const name = path.basename(MODULE);
  describe(`sandbox 40: when CHUtil's HTTP helper loads, in ${where}`, function() {
    this.timeout(120000);
    let home = null;
    let io = null;
    let server = null;
    let base = null;
    let tool = null;
    let id = 10;

    before(async () => {
      home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-sb-40-'));
      server = await startStandIn();
      base = server.base;
      io = start(home, flags, MODULE);
      await request(io, {jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {name: 'test', version: '0'}}});
      io.child.stdin.write(`${JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'})}\n`);
      const deadline = Date.now() + 60000;
      while (tool == null && Date.now() < deadline) {
        const listed = await request(io, {jsonrpc: '2.0', id: id++, method: 'tools/list'});
        tool = ((listed.result || {}).tools || []).find((t) => /probe/.test(t.name));
        if (tool == null) await new Promise((r) => setTimeout(r, 250));
      }
      assert.ok(tool != null, `the probe was not listed: ${io.err.slice(-3000)}`);
    });
    after(async () => {
      if (io != null) io.child.kill('SIGKILL');
      if (server != null) await server.close();
      if (home != null) fs.rmSync(home, {recursive: true, force: true});
    });

    const probe = async (args) => {
      const r = await request(io, {jsonrpc: '2.0', id: id++, method: 'tools/call', params: {name: tool.name, arguments: args}});
      assert.ok(r.result != null && r.result.isError !== true, JSON.stringify(r).slice(0, 2000));
      return r.result.structuredContent != null ? r.result.structuredContent : JSON.parse(r.result.content[0].text);
    };

    it(atBoot ? 'postman-request is loaded by the time module code runs (before the lockdown)' : 'the module\'s boot does not load postman-request', async () => {
      assert.deepStrictEqual((await probe({what: 'loaded'})).loaded, {request: atBoot});
    });

    if (refuses) {
      it(`a CHUtil.request to an undeclared host is refused${atBoot ? '' : ', and loads nothing'}`, async () => {
        const r = await probe({what: 'request', url: UNDECLARED});
        assert.strictEqual(r.code, 'ERR_ACCESS_DENIED', JSON.stringify(r));
        assert.deepStrictEqual(r.loaded, {request: atBoot});
      });
    }

    if (mode === 'audit') {
      // localhost is not the declared 127.0.0.1, and needs no lookup beyond the hosts file.
      it(`a CHUtil.request to an undeclared host is reported under audit, and allowed${atBoot ? '' : ' (the library loads then, after the lockdown)'}`, async () => {
        const r = await probe({what: 'request', url: `http://localhost:${server.port}/`});
        assert.notStrictEqual(r.code, 'ERR_ACCESS_DENIED', JSON.stringify(r));
        const line = new RegExp(`${name} violation net localhost`);
        const deadline = Date.now() + 5000;
        while (!line.test(io.err) && Date.now() < deadline) await new Promise((res) => setTimeout(res, 50));
        assert.match(io.err, line);
        assert.strictEqual(r.loaded.request, true);
      });
    }

    if (declares) {
      it(`a CHUtil.request to a declared host works${atBoot ? '' : ', and loads postman-request only then'}`, async () => {
        const r = await probe({what: 'request', url: `${base}/`});
        assert.deepStrictEqual([r.outcome, r.status, r.body], ['ok', 200, 'ok'], JSON.stringify(r));
        assert.deepStrictEqual(r.loaded, {request: true});
      });
    }
  });
});
