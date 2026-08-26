// Stop-condition check for examples/repo-review: does ctx identity pass-through
// behave the same at four levels (outer call + three inner hops) as it does at
// two? Mirrors test/auth/13-ctx-billing-identity.js's setup exactly -- non-debug
// and multi-tenant, because under --debug every key resolves to an admin
// session and neither half of the authorize/bill split is observable.
const assert  = require('assert');
const fs      = require('fs');
const path    = require('path');
const exec    = require('child_process').exec;
const request = require('supertest');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PORT      = 9594;
const url       = `http://127.0.0.1:${PORT}`;
const AUTH_PATH = `/tmp/countinghouse-verify-4hop-${process.pid}.json`;

const CALLER      = `caller-4hop-${process.pid}`;
const AS_IDENTITY = 'repo-review-internal';

const REVIEW_DEVICE = '51b0d6ac-7a77-5083-8476-26a9be96a101';
const SCAN_DEVICE   = '1359302a-e4fe-5c14-853b-f83638e8ca01';
const DETECT_DEVICE = '7d4e06e9-0742-556b-a7f2-a32aee36e2e7';
const AUDIT_DEVICE  = '01919ef1-dd71-5d42-99ce-98decb9a2408';

// The caller is granted the composite device ONLY. If authorization used the
// caller's identity, every inner hop would fail; if it uses the module's, they
// succeed. Same encapsulation assertion as the 2-hop test, one hop deeper.
function writeAuth() {
  const config = {};
  config[CALLER]      = {userName: 'caller', devices: [REVIEW_DEVICE]};
  // "runsModules" is what binds AS_IDENTITY as repo-review's ctx.call
  // identity (DeviceManager.prototype.verifyComposition, load-time) -- since
  // repo-review's package.json declares "countinghouse.calls", the module
  // now refuses to come online without this, same as the real auth.json.
  config[AS_IDENTITY] = {userName: AS_IDENTITY, devices: [SCAN_DEVICE, DETECT_DEVICE, AUDIT_DEVICE],
                          runsModules: ['repo-review']};
  fs.writeFileSync(AUTH_PATH, JSON.stringify(config, null, 2));
}

function startServer(cb) {
  writeAuth();
  exec(`"./bin/countinghouse" --workerThread --bindAddr 127.0.0.1 --port ${PORT
       } --authProvider file --authConfigPath ${AUTH_PATH} --mcpToolCallCost 1` +
       ' --loadModule ./examples/repo-review/repo-scan' +
       ' --loadModule ./examples/repo-review/secret-detect' +
       ' --loadModule ./examples/repo-review/dep-audit' +
       ' --loadModule ./examples/repo-review/repo-review',
       // Anchored to the repo root rather than the caller's cwd, so this runs
       // the same from anywhere -- every path above is repo-relative.
       {cwd: REPO_ROOT}, () => {});
  setTimeout(cb, 16000);
}

function balanceOf(key, cb) {
  request(url).get('/balance').set('X-CH-Key', key).end((err, res) => {
    if (err) return cb(err);
    return cb(null, (res.body != null) ? res.body.balance : null);
  });
}

function settledBalance(key, cb) {
  const deadline = Date.now() + 20000;
  let last = null, stable = 0;
  (function poll() {
    balanceOf(key, (err, balance) => {
      if (err) return cb(err);
      stable = (last !== null && balance === last) ? stable + 1 : 1;
      last = balance;
      if (stable >= 3) return cb(null, balance);
      if (Date.now() >= deadline) return cb(new Error(`balance for ${key} never settled (last ${balance})`));
      setTimeout(poll, 200);
    });
  })();
}

function callReview(key, cb) {
  request(url).post('/mcp')
  .set('Content-Type', 'application/json').set('X-CH-Key', key)
  .send({jsonrpc: '2.0', id: 1, method: 'tools/call',
         params: {name: 'repo_review_reviewservice_review',
                  arguments: {include: ['lib/**/*.js', 'package.json', 'package-lock.json']}}})
  .end((err, res) => {
    if (err) return cb(err);
    return cb(null, res.body != null ? res.body.result : null);
  });
}

function listTools(key, cb) {
  request(url).post('/mcp')
  .set('Content-Type', 'application/json').set('X-CH-Key', key)
  .send({jsonrpc: '2.0', id: 9, method: 'tools/list'})
  .end((err, res) => {
    if (err) return cb(err);
    return cb(null, res.body.result.tools.map((t) => t.name));
  });
}

function fail(msg, e) {
  console.error(`\nFAIL: ${msg}`);
  if (e) console.error(e);
  cleanup(() => process.exit(1));
}

function cleanup(cb) {
  exec(`pkill -f "[f]ramework.js.*${AUTH_PATH}"`, () => {
    try { fs.unlinkSync(AUTH_PATH); } catch (e) { /* already gone */ }
    setTimeout(cb, 1500);
  });
}

console.log('starting countinghouse WITHOUT --debug, multi-tenant, 4 modules...');
startServer(() => {
  listTools(CALLER, (err, names) => {
    if (err) return fail('tools/list failed', err);
    const deviceTools = names.filter((n) => n !== 'countinghouse_check_balance');
    console.log(`\n[1] tools/list for the caller: ${JSON.stringify(deviceTools)}`);
    assert.deepStrictEqual(deviceTools, ['repo_review_reviewservice_review'],
      'only the composite tool must be exposed to a caller granted only that device');
    console.log('    OK -- repo_review is the only externally visible tool.');

    settledBalance(CALLER, (e1, callerBefore) => {
      if (e1) return fail('caller balance never settled', e1);
      settledBalance(AS_IDENTITY, (e2, internalBefore) => {
        if (e2) return fail('internal balance never settled', e2);
        console.log(`\n[2] balances before: caller=${callerBefore} internal=${internalBefore}`);

        callReview(CALLER, (e3, result) => {
          if (e3) return fail('tools/call failed', e3);
          if (result == null) return fail('no result at all');
          if (result.isError !== false) return fail(`call errored: ${JSON.stringify(result).slice(0, 1500)}`);

          const out = result.structuredContent.output;
          console.log(`\n[3] all ${out.bill.length} inner hops succeeded with no caller grant to the inner devices.`);
          out.bill.forEach((b) => console.log(`    hop ${b.hop} ${b.tool.padEnd(22)} charged=${b.charged} balance=${b.balance} billedTo=${b.billedTo} authorizedAs=${b.authorizedAs}`));

          assert.strictEqual(out.bill.length, 3, 'expected exactly 3 inner hops');
          out.bill.forEach((b) => {
            assert.strictEqual(b.billedTo, CALLER, `hop ${b.hop} must be billed to the real outer caller`);
            assert.strictEqual(b.authorizedAs, AS_IDENTITY, `hop ${b.hop} must be authorized as the module`);
            assert.strictEqual(b.charged, 1, `hop ${b.hop} must be charged exactly once`);
          });
          // The decisive shape check: three hops, three independent, monotonic
          // balance records -- not one charge replayed or a hop metered twice.
          const balances = out.bill.map((b) => b.balance);
          assert.deepStrictEqual(balances, [balances[0], balances[0] - 1, balances[0] - 2],
            `per-hop balances must step by exactly one charge each, got ${JSON.stringify(balances)}`);
          console.log('    OK -- ctx.caller reaches hop 3 exactly as it reaches hop 1.');

          settledBalance(CALLER, (e4, callerAfter) => {
            if (e4) return fail('caller balance never settled after', e4);
            settledBalance(AS_IDENTITY, (e5, internalAfter) => {
              if (e5) return fail('internal balance never settled after', e5);

              const callerPaid   = callerBefore - callerAfter;
              const internalPaid = internalBefore - internalAfter;
              console.log(`\n[4] caller paid ${callerPaid} (outer call + 3 hops), module identity paid ${internalPaid}`);

              assert.strictEqual(callerPaid, 4,
                `caller must pay the outer call plus all three hops, paid ${callerPaid}`);
              assert.strictEqual(internalPaid, 0,
                `the module identity must not be billed at all, but paid ${internalPaid}`);
              console.log('    OK -- identical to the 2-hop behaviour, one hop deeper.');

              console.log('\nRESULT: 4-hop ctx identity pass-through matches 2-hop behaviour. No stop condition triggered.');
              cleanup(() => process.exit(0));
            });
          });
        });
      });
    });
  });
});
