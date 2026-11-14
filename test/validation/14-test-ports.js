// Every server test's port honours CH_TEST_PORT_BASE (test/helpers/run-local.js):
// the helpers map every port they take through testPort, and testPort hands
// a port it already mapped back as it is, so a test that maps its own
// constant and passes it to a helper is not mapped twice. Unset (CI), every
// port is the test's own. The base is read when test-env loads, so each case
// runs in a child process.
const assert = require('assert');
const path = require('path');
const {execFileSync} = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const probe = (env) => JSON.parse(execFileSync(process.execPath, ['-e', `
  const {testPort} = require('./test/helpers/test-env');
  const {url} = require('./test/helpers/sandbox-server');
  const mapped = testPort(9749);
  console.log(JSON.stringify({mapped, again: testPort(mapped), same: testPort(9749), other: testPort(9688), url: url(9749), urlOfMapped: url(mapped)}));
`], {cwd: ROOT, env: Object.assign({}, process.env, env), encoding: 'utf8'}));

describe('validation 14: server tests\' ports and CH_TEST_PORT_BASE', () => {
  it('with a base: each default gets the next port; a mapped port is handed back as it is; url() maps as startServer does', () => {
    assert.deepStrictEqual(probe({CH_TEST_PORT_BASE: '9900'}),
      {mapped: 9900, again: 9900, same: 9900, other: 9901, url: 'http://127.0.0.1:9900', urlOfMapped: 'http://127.0.0.1:9900'});
  });

  it('without one (CI): every port is the test\'s own', () => {
    assert.deepStrictEqual(probe({CH_TEST_PORT_BASE: ''}),
      {mapped: 9749, again: 9749, same: 9749, other: 9688, url: 'http://127.0.0.1:9749', urlOfMapped: 'http://127.0.0.1:9749'});
  });
});
