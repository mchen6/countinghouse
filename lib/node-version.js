// countinghouse 8 needs Node 22.16: module.registerHooks and Worker
// getHeapStatistics (the module sandbox) and the --permission flag
// (--hardened) all arrive by then. framework.js checks this before anything
// else starts.
const MIN = '22.16.0';

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
  return `countinghouse 8 needs Node 22.16 or later (this is ${version})`;
}

module.exports = {MIN, supported, message};
