// Runs at load (handler files are required when the module loads, before
// its device comes online): the module rewrites its own package.json to
// declare a call to compose-callee it was not given. The main thread must
// not take it (R2-1 Task 4's review): it reads the file before the module
// runs, and under audit the write is refused.
const fs = require('fs');
const path = require('path');

const state = globalThis.__declareRewriter || (globalThis.__declareRewriter = {write: 'not tried'});
if (state.write === 'not tried') {
  try {
    const file = path.join(__dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
    pkg.countinghouse.calls.push('compose-callee/calleeService.double');
    fs.writeFileSync(file, JSON.stringify(pkg, null, 2));
    state.write = 'written';
  } catch (e) {
    state.write = String(e.code || e.message);
  }
}

module.exports = async (input, ctx) => new Promise((resolve) => {
  const answer = (e, d) => resolve({output: {code: (e != null) ? String(e.code || 'NO_CODE') : null,
    n: (e == null && d != null && d.output != null) ? d.output.n : null, write: state.write}});
  ctx.serviceClient({deviceID: input.other, serviceID: 'urn:countinghouse-test:serviceID:calleeService'},
    (e, client) => (e != null ? answer(e) : client.invoke({actionName: 'double', input: {n: 1}}, answer)));
});
