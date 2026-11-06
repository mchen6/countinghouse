// countinghouse_validate_module requires the module's code. It ran in a
// plain child process with the server's whole environment and no sandbox,
// even under enforce and --hardened, while load_module runs sandboxed (review
// R1-4). Under audit and enforce it now runs in a sandboxed worker that is
// discarded afterwards (user decision, 2026-11-04): the module's namespace,
// declared env, limits and lockdown, no main-thread services, a throwaway
// data directory, and at most two at a time. Under off, where a worker gets
// the whole environment, it stays a child process with a clean environment.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {ROOT, startServer, stopServer, mcpCall, waitFor} = require('../helpers/sandbox-server');
const {mkdtemp} = require('../helpers/test-tmp');

const PROBE = path.join(ROOT, 'test', 'fixtures', 'validate-probe');
const SLOW = path.join(ROOT, 'test', 'fixtures', 'validate-slow');
const validate = (port, p) => mcpCall(port, 'k', 'countinghouse_validate_module', {path: p});
const seenBy = (r) => {
  const out = r.structuredContent != null ? r.structuredContent : r;
  const text = JSON.stringify(out);
  const m = /VALIDATE-PROBE (\{[^}]*\})/.exec(text.replace(/\\"/g, '"'));
  return {out: out, seen: m != null ? JSON.parse(m[1]) : null, text: text};
};

describe('sandbox 21: countinghouse_validate_module in a sandboxed worker', function() {
  this.timeout(120000);
  let server = null;
  let base = null;
  afterEach(() => {
    stopServer(server); server = null;
    if (base) fs.rmSync(base, {recursive: true, force: true}); base = null;
  });
  const start = async (mode, extra) => {
    base = base || mkdtemp('validate-');
    server = await startServer(9666, ['--workerThread', '--debug', '--debugKey', 'k', '--authoringTools', '--moduleSandbox', mode,
      '--moduleDataPath', path.join(base, 'store')].concat(extra || []), {env: {COUNTINGHOUSE_TEST_SECRET: 's3cret'}});
  };

  it('enforce: the module sees no server secret and nothing outside its namespace', async () => {
    await start('enforce');
    const r = seenBy(await validate(9666, PROBE));
    assert.strictEqual(r.out.ok, false, r.text);
    assert.deepStrictEqual(r.seen && {secret: r.seen.secret, outside: r.seen.outside}, {secret: 'hidden', outside: 'ENOENT'}, r.text);
  });

  it('main-thread messages a validation does not need are refused, and the validation still finishes', async () => {
    await start('enforce');
    const r = seenBy(await validate(9666, PROBE));
    assert.strictEqual(r.seen && r.seen.forged, 'sent', r.text);
    await new Promise((resolve) => setTimeout(resolve, 500));
    ['rediscommand', 'invokeforeignaction'].forEach((c) =>
      assert.ok(new RegExp(`validate: refused ${c}`).test(server.output), `${c} not refused:\n${server.output.slice(-2000)}`));
  });

  it('leaves no tools and no data behind', async () => {
    await start('enforce');
    await validate(9666, PROBE);
    const list = await mcpCall(9666, 'k', 'countinghouse_list_tools', {}, {allowUnknownTool: true});
    assert.ok(!/validate_probe/.test(JSON.stringify(list)), JSON.stringify(list).slice(0, 300));
    // The answer comes before the teardown: validateModuleSandboxed calls
    // back with the result, then removes its throwaway directory once the
    // worker has ended and the broker gone idle. Wait for that, bounded,
    // instead of reading the directory the moment the answer arrives.
    const dir = path.join(base, 'store', '.validate');
    const left = () => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);
    await waitFor(() => left().length === 0, 10000, 'the throwaway directory to be removed', async () => JSON.stringify(left()));
    assert.deepStrictEqual(left(), []);
  });

  it('a stale throwaway directory is removed at startup', async () => {
    base = mkdtemp('validate-');
    fs.mkdirSync(path.join(base, 'store', '.validate', 'stale', 'validate', 'data'), {recursive: true});
    await start('enforce');
    assert.strictEqual(fs.existsSync(path.join(base, 'store', '.validate', 'stale')), false);
  });

  it('at most two validations at a time; a third is answered busy', async () => {
    await start('audit');
    const results = await Promise.all([validate(9666, SLOW), validate(9666, SLOW), validate(9666, SLOW)]);
    const busy = results.filter((r) => /busy/.test(JSON.stringify(r)));
    assert.strictEqual(busy.length, 1, JSON.stringify(results).slice(0, 800));
  });

  it('a module that exits while being validated is reported, not a server error', async () => {
    await start('enforce');
    const r = await validate(9666, path.join(ROOT, 'test', 'fixtures', 'handler-map-process-exit'));
    const out = r.structuredContent != null ? r.structuredContent : r;
    assert.strictEqual(out.ok, false, JSON.stringify(r));
    assert.ok(out.problems.some((p) => /ended its validation|exit/i.test(p.message)), JSON.stringify(out));
    assert.strictEqual((await mcpCall(9666, 'k', 'countinghouse_validate_module', {path: PROBE})).isError, false, 'the server still answers');
  });

  // A worker that ends itself emits 'exit' once; the teardown must not wait
  // for a second one, or the busy count and the throwaway directory leak
  // (review R1-4a).
  it('modules that exit leave no busy slot and no data behind', async () => {
    await start('enforce');
    const EXIT = path.join(ROOT, 'test', 'fixtures', 'handler-map-process-exit');
    for (let i = 0; i < 3; i++) await validate(9666, EXIT);
    const after = await validate(9666, PROBE);
    assert.ok(!/busy/.test(JSON.stringify(after)), `still busy: ${JSON.stringify(after).slice(0, 300)}`);
    const dir = path.join(base, 'store', '.validate');
    const left = () => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);
    for (let i = 0; i < 50 && left().length > 0; i++) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepStrictEqual(left(), []);
  });

  it('off: a child process with a clean environment (no server secret)', async () => {
    await start('off');
    const r = seenBy(await validate(9666, PROBE));
    assert.strictEqual(r.seen && r.seen.secret, 'hidden', r.text);
  });
});
