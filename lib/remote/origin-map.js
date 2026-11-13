// --remoteOriginMap (acceptance runs only; reviewer, 2026-11-12): which
// declared origins' transports go to a local stand-in.
//
// The map is fixed at start, once: framework.js parses the option, checks it
// whole (the Redis endpoint included, so a wrong option is blamed on the
// option), and activates it only with COUNTINGHOUSE_ACCEPTANCE=1. The value is
// frozen and held here, in this module's closure, never on the shared
// cli-options object, so no option, setOptions() call or later environment
// change turns a map on or off or changes where it points; a second
// activation throws. (In single-thread mode a module runs with this process's
// full privileges anyway; in worker mode this object lives on the main thread,
// out of every module's reach.)
const {refusedAddress, portOf} = require('./declaration');

const FORM = 'must be <declared https origin>=<http://127.0.0.1:port or http://[::1]:port>';
const TARGET = /^http:\/\/(127\.0\.0\.1|\[::1\]):(\d{1,5})$/;

let active = null;

// One option value or several (repeated) -> {map} | {problem}. map: a frozen
// {<normalised declared origin>: frozen {target, url}}; url is the target,
// parsed once.
function parse(value) {
  if (value == null || value === false) return {map: null};
  const map = {};
  for (const item of (Array.isArray(value) ? value : [value])) {
    const s = String(item);
    const eq = s.indexOf('=');
    const key = eq < 0 ? s : s.slice(0, eq);
    const target = eq < 0 ? '' : s.slice(eq + 1);
    const refuse = (why) => ({problem: `--remoteOriginMap ${JSON.stringify(s)}: ${why}`});
    if (eq < 0) return refuse(FORM);
    let k = null;
    try { k = new URL(key); } catch (e) { k = null; }
    if (k == null || k.protocol !== 'https:' || /[/?#@]/.test(key.slice('https://'.length))) {
      return refuse('the declared origin must be an https origin (scheme, host and port only), as the remote declares it');
    }
    // The target's host and port as written (http://127.0.0.1:80 included),
    // then checked as parsed: a port from 1 to 65535.
    const m = TARGET.exec(target);
    const port = m != null ? Number(m[2]) : NaN;
    if (m == null || !(port >= 1 && port <= 65535)) return refuse('the target must be http://127.0.0.1:<port> or http://[::1]:<port>, with a port from 1 to 65535');
    // Keyed as the runtime reads a declaration's origin: normalised.
    if (Object.prototype.hasOwnProperty.call(map, k.origin)) return refuse('maps that origin twice');
    map[k.origin] = Object.freeze({target: target, url: new URL(target)});
  }
  return {map: Object.freeze(map)};
}

// map (parse's) and redisEndpoint ({host, port}, or null when no Redis is
// configured: --store local) -> [problem]: a target is never the Redis
// endpoint, as a declared address never is.
function problems(map, redisEndpoint) {
  const out = [];
  for (const [origin, {target, url}] of Object.entries(map || {})) {
    const why = refusedAddress(url.hostname, portOf(url), {debug: true, redisEndpoint: redisEndpoint});
    if (why != null) out.push(`--remoteOriginMap ${origin}=${target}: the target is refused: ${why}`);
  }
  return out;
}

// Once, at start (framework.js). -> nothing; throws on a second activation.
function activate(map) {
  if (active != null) throw new Error('--remoteOriginMap is already in effect: the map is fixed at start');
  if (map == null || Object.keys(map).length === 0) throw new Error('--remoteOriginMap: nothing to activate');
  active = map;
}

// -> the active map, or null.
function current() {
  return active;
}

// For the tests alone, which run several files in one process; nothing in
// the runtime calls it. It works only under the test flag every mocha run
// sets (test/helpers/require-thread-flag.js), as the other test-only hooks do.
function deactivateForTests() {
  if (process.env.COUNTINGHOUSE_TEST_REQUIRE_THREAD_FLAG !== '1') {
    throw new Error('deactivateForTests: only under the test flag (COUNTINGHOUSE_TEST_REQUIRE_THREAD_FLAG=1): the map is fixed at start');
  }
  active = null;
}

module.exports = {parse, problems, activate, current, deactivateForTests};
