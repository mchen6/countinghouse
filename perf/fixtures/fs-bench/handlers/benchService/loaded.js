// Workload L: the module requires every package deps.json names when it
// loads (none in the fixture; perf/fs-broker-workloads.js generates a
// dependency-heavy node_modules in a copy). This action answers once it is
// loaded.
const deps = require('../../deps.json');
deps.forEach((name) => require(name));
module.exports = async () => ({output: {deps: deps.length}});
