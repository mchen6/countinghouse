// What the module sandbox needs from Node, and whether this runtime has it.
// package.json allows Node 20, but the sandbox's require boundary needs
// module.registerHooks, its memory watch needs Worker getHeapStatistics
// (both from Node 22.16), and --hardened needs the --permission flag (Node
// 22.13; Node 20 only has --experimental-permission). Without them the
// default mode drops to off (lib/cli-options.js) and an explicit mode or
// --hardened is refused at startup (framework.js).
const Module = require('module');
const Worker = require('worker_threads').Worker;

const MIN_NODE = '22.16';
const PERMISSION_MIN_NODE = '22.13';

// env is for tests: {Module, Worker} stand-ins.
function missing(env) {
  const M = (env != null) ? env.Module : Module;
  const W = (env != null) ? env.Worker : Worker;
  const out = [];
  if (typeof(M.registerHooks) !== 'function') out.push('module.registerHooks');
  if (typeof(W.prototype.getHeapStatistics) !== 'function') out.push('Worker.getHeapStatistics');
  return out;
}

// argvMode: the raw --moduleSandbox value, or undefined when not given.
function resolveMode(argvMode, workerThread, missingApis) {
  if (argvMode != null) return {mode: String(argvMode), explicit: true};
  return {mode: (workerThread === true && missingApis.length === 0) ? 'audit' : 'off', explicit: false};
}

function hasPermissionModel(flags) {
  return (flags != null ? flags : process.allowedNodeEnvironmentFlags).has('--permission');
}

module.exports = {MIN_NODE, PERMISSION_MIN_NODE, missing, resolveMode, hasPermissionModel};
