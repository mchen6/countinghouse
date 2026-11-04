// countinghouse 8 needs Node 24.15: module.registerHooks resolve hooks see
// require.resolve and createRequire().resolve only from 24.15 (22.x and
// earlier 24.x skip them, so module code's require.resolve fails in worker
// mode); Worker getHeapStatistics and --permission are older. framework.js
// checks this before anything else starts.
const MIN = '24.15.0';

function parts(version) {
  return String(version).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
}

function supported(version) {
  const have = parts(version);
  const need = parts(MIN);
  for (let i = 0; i < 3; i++) {
    if (have[i] !== need[i]) return have[i] > need[i];
  }
  return true;
}

function message(version) {
  return `countinghouse 8 needs Node 24.15 or later (this is ${version})`;
}

module.exports = {MIN, supported, message};
