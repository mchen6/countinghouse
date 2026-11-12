// The test folders are listed once, in test/folders.json (reviewer,
// 2026-11-12): `npm test` (scripts/run-tests.js) and ci.yml's functional
// step both read it, so a PR adding a folder changes one line in one file
// instead of conflicting on the long script line. This pins that the list
// reproduces the two hand-kept lists it replaced, run for run.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {plan} = require('../../scripts/run-tests');

const ROOT = path.join(__dirname, '..', '..');
const asLine = (run) => (run.npm != null ? `npm run ${run.npm}` : `mocha ${run.exit ? '--exit ' : ''}${run.files.join(' ')}`);

// master 73984ad's `npm test`, split on &&, and its ci.yml functional step
// (one order, see below), plus the runs added since: jobs-local (LM1 B5).
const NPM_TEST = 'mocha ./test/test1.js && mocha ./test/test2.js && mocha ./test/test3.js && mocha ./test/test4.js && mocha --exit ./test/test5.js && mocha ./test/auth/*.js ./test/fs-broker/*.js ./test/device-config/*.js ./test/module-loading/*.js ./test/spec-format/*.js ./test/mcp-contract/*.js ./test/validation/*.js ./test/module-authoring/*.js ./test/store/*.js ./test/metering/*.js ./test/local-kv/*.js && mocha ./test/jobs-local/*.js && mocha --exit ./test/composition/*.js && mocha --exit ./test/roles/*.js && mocha --exit ./test/usage/*.js && mocha --exit ./test/stdio/*.js && mocha --exit ./test/sandbox/*.js && mocha --exit ./test/remote/*.js && mocha --exit ./test/single-thread/*.js && mocha ./test/test8.js && npm run test:peer-standalone && mocha ./test/test6.js && mocha ./test/test7.js';
const CI_STEP = ['mocha ./test/test1.js', 'mocha ./test/test2.js', 'mocha ./test/test3.js', 'mocha ./test/test4.js', 'mocha --exit ./test/test5.js',
  'mocha ./test/auth/*.js ./test/fs-broker/*.js ./test/device-config/*.js ./test/module-loading/*.js ./test/spec-format/*.js ./test/mcp-contract/*.js ./test/validation/*.js ./test/module-authoring/*.js ./test/store/*.js ./test/metering/*.js ./test/local-kv/*.js',
  'mocha ./test/jobs-local/*.js',
  // The old ci.yml ran remote before sandbox and the npm script sandbox before
  // remote; one list keeps one order (the npm script's). The folders do not
  // depend on each other.
  'mocha --exit ./test/composition/*.js', 'mocha --exit ./test/roles/*.js', 'mocha --exit ./test/usage/*.js', 'mocha --exit ./test/sandbox/*.js', 'mocha --exit ./test/remote/*.js',
  'mocha --exit ./test/single-thread/*.js', 'mocha ./test/test8.js', 'npm run test:peer-standalone', 'mocha ./test/test6.js'];

describe('validation 08: the test folders are listed once', () => {
  it('npm test runs exactly the runs the old script line ran, in order', () => {
    assert.deepStrictEqual(plan({ci: false}).map(asLine), NPM_TEST.split(' && '));
  });

  it('CI runs exactly the runs its functional step listed, in order (stdio has its own job; test7 is a benchmark)', () => {
    assert.deepStrictEqual(plan({ci: true}).map(asLine), CI_STEP);
  });

  it('package.json and ci.yml both read the list, and neither keeps a folder list of its own', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.strictEqual(pkg.scripts.test, 'node scripts/run-tests.js');
    const ci = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    const step = ci.slice(ci.indexOf('- name: Run functional tests'), ci.indexOf('- name: npm audit'));
    assert.match(step, /run: node scripts\/run-tests\.js --ci\n/);
    assert.doesNotMatch(step, /npx mocha/);
  });
});
