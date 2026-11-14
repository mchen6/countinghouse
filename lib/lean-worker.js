//workaround worker thread issue which didn't set process.umask as a function
process.umask = function() {};

// File broker (module sandbox part 2): patch fs before anything else
// loads, so nothing in this worker holds an unbrokered fs.
const fsWorkerData = require('worker_threads').workerData || {};
// The loader's grant controller (lib/fs-broker/patch.js): kept here, out of
// reach of module code, and handed to the loader hook at set-options.
let fsGrant = null;
// countinghouse's own boot requires read its code with the original fs until
// set-options; no module code runs before then (review C1).
let releaseBoot = () => {};
if (fsWorkerData.fsBridge != null) {
  // Loaded now, under the boot grant: set-options installs it after the grant ends.
  require('./fs-broker/identity');
  fsGrant = require('./fs-broker/patch').install(require('./fs-broker/client').createClient(fsWorkerData.fsBridge)).grant;
  // countinghouse's code roots, real paths from the main thread (identity.codeRootsFor).
  releaseBoot = fsGrant.boot(fsWorkerData.codeRoots);
}


// The lean worker (docs/superpowers/specs/2026-11-13-lean-worker-design.md
// sections 1-3; lean worker step 3, Task 3b): what every module runs in. It
// loads the module's handler files and answers invokes through
// lib/lean-dispatcher.js: no ModuleManager, CdifInterface, DeviceManager,
// CHDevice or Service, no discovery and no device events. The main thread
// registers a module's devices from its own copy of the spec. The prelude
// above is the old lib/sandbox.js's, verbatim; the messages below are its worker
// side, minus get-spec, get-schema and discover-device.
const fs             = require('fs');
const path           = require('path');
const isMainThread   = require('worker_threads').isMainThread;
// taken now, before the lockdown, for the runtime files loaded on first use
require('./thread-info');
const parentPort     = require('worker_threads').parentPort;

const options        = require('./cli-options');
// A worker is single-threaded inside; set-options (below) replaces these with
// the main thread's options, with workerThread forced false again.
options.setOptions({workerThread: false});

// The logger, on the first line logged (lean worker step 3, Task 5): a worker
// that logs nothing never loads it.
let logger = null;
const log = () => {
  if (logger == null) logger = require('./logger');
  if (logger.logger == null) logger.createLogger(false);
  return logger;
};
const LOG = {E: (e) => log().E(e), I: (line) => log().I(line)};

process.on('uncaughtException', (e) => {
  LOG.E(new Error(`Uncaught exception in worker thread: ${e.stack}`));
});

const WorkerMessage   = require('./worker-message');
// this worker's ONE WorkerMessage: replies to the main thread, and the
// queue its *-reply messages settle
const wm = new WorkerMessage(null);
// Taken before the lockdown (set-options), which watches v8 from then on:
// the reply's size check (--maxOutputBytes) is the runtime's own use of it.
const v8Serialize     = require('v8').serialize;
const {CountinghouseError, hopError} = require('./countinghouse-error');
const {createDispatcher} = require('./lean-dispatcher');
const {readField}     = require('./handler-answer');
const chutilFacade    = require('./chutil-facade');

// The worker's peer state (lib/peer-worker.js runs with it as `this`), and
// what CHUtil and ServiceClient reach as CHUtil.dm: the worker's
// WorkerMessage, its hop to the main thread, its peer channels. The peer
// functions are loaded on first use: a worker that never opens a channel
// never loads them.
const PEER_METHODS = ['invokeActionViaPeerChannel', 'onPeerChannelGrant', 'onPeerAnnounceRefused', 'onPeerChannelDeny',
  'flushPendingPeerInvokes', 'onPeerChannelOpen', 'onPeerChannelAllow', 'onPeerInvalidate'];
const peerDm = Object.assign({}, {
  peerChannels:        {},
  peerDeviceWorkerMap: {},
  pendingPeerInvokes:  {},
  workerMessage:       wm,
  sendActionInvokeMessageToParent(appKey, billingKey, deviceID, serviceID, actionName, args, callback) {
    return wm.sendActionInvokeMessageToParent(appKey, billingKey, deviceID, serviceID, actionName, args, callback);
  },
  // the main thread's event path only; a worker queries over its WorkerMessage
  emit() { return false; }
});
for (const name of PEER_METHODS) {
  peerDm[name] = function(...args) { return require('./peer-worker').methods[name].apply(peerDm, args); };
}

// The module this worker runs, once load-module has required its handlers.
let dispatcher = null;
// Set by unload-module: an invoke still in flight to this worker is answered
// with why its module ended, as DeviceManager's missingDeviceError did.
let endingCode = null;

// What CHUtil reaches as CHUtil.ci: ServiceClient's hop goes through its
// deviceManager (the peer state above), and a peer channel's callee side
// (lib/peer-worker.js onPeerChannelOpen) serves an invoke with
// invokeDeviceAction. Such a call was not checked by the main thread, so it
// is validated here.
const leanCi = {
  deviceManager: peerDm,
  invokeDeviceAction(deviceID, serviceID, actionName, args, callback) {
    return invokeHere(deviceID, serviceID, actionName, args, false, callback);
  }
};

// countinghouse-util, whenever it is first loaded (the facade, handler-ctx
// or the peer side), is wired to this worker: its dm, its ci and its Redis
// bridge. The module's global CHUtil is the facade (lib/chutil-facade.js),
// installed before set-options locks its routes out.
chutilFacade.setWiring((impl) => {
  // it, and what it requires, log through the logger: created now
  log();
  impl.dm = peerDm;
  impl.ci = leanCi;
  const redisAPI = require('./redis-api');
  redisAPI.init(peerDm);
  impl.redis = redisAPI.client;
});
global.CHUtil = chutilFacade.createFacade();

// A direct peer channel's call is validated in this worker, by the same
// Service code a validator worker runs (until lean worker step 4 moves it):
// loaded on the first such call, never for the main thread's checked ones.
let peerServices = null;
function peerServiceOf(serviceID) {
  if (peerServices == null) {
    const Service   = require('./service');
    const validator = require('./validator');
    const CHDevice  = require('./countinghouse-device');
    const spec = dispatcher.device.spec;
    let schemaDoc = null;
    try { schemaDoc = JSON.parse(fs.readFileSync(path.join(dispatcher.modulePath, 'schema.json'), 'utf8')); } catch (e) { schemaDoc = null; }
    const device = {spec: spec, schemaDoc: schemaDoc, lazySchemas: true,
      schemaValidator: validator.createSchemaValidator({}), resolveSchemaFromPath: CHDevice.prototype.resolveSchemaFromPath};
    peerServices = Object.create(null);
    const list = spec.device.serviceList;
    for (const id of Object.keys(list)) peerServices[id] = new Service(device, id, list[id]);
  }
  return Object.hasOwn(peerServices, serviceID) ? peerServices[serviceID] : null;
}
function checkPeerOutput(serviceID, actionName, output) {
  const service = peerServiceOf(serviceID);
  return (service == null) ? null : service.refuseData(service.actions[actionName], output, false);
}

function invokeHere(deviceID, serviceID, actionName, args, mainChecked, callback) {
  if (dispatcher == null || deviceID !== dispatcher.device.deviceID) {
    return callback((endingCode != null) ? new CountinghouseError(endingCode, deviceID) : new CountinghouseError('DEVICE_NOT_FOUND', deviceID), null);
  }
  if (endingCode != null) return callback(new CountinghouseError(endingCode, deviceID), null);
  if (mainChecked === true) return dispatcher.invoke(serviceID, actionName, args, true, callback);
  const service = peerServiceOf(serviceID);
  if (service == null) return dispatcher.invoke(serviceID, actionName, args, false, callback);
  return service.compileAction(actionName).then(() => {
    const refused = service.refuseCall(actionName, args, false, true);
    if (refused != null) return callback(refused[0], refused[1]);
    return dispatcher.invoke(serviceID, actionName, args, false, callback);
  }, (e) => callback(e, null));
}

if (!isMainThread) {
  parentPort.on('message', (msg) => {
    switch (msg.command) {
      case 'set-options': {
        // MUST disable options.workerThread here because this flag is enabled only in main thread
        // or else main thread will recursively run the load module path
        msg.options.workerThread = false;
        options.setOptions(msg.options);
        // Release mode drops module console output. Done once for the whole
        // worker, before any module code loads, so it covers a module's
        // dependencies as well as its own files. countinghouse's own logging
        // goes through LOG, not console, and is unaffected.
        require('./fs-broker/patch').setConsoleSilenced(options.debug !== true);
        if (options.debug !== true) {
          Object.keys(console).forEach((key) => {
            if (typeof(console[key]) === 'function') console[key] = function() {};
          });
        }
        // Virtual module identity and the bounded loader (part 2, plan 3), in
        // every mode: registered after part 1's hooks so it runs first, and
        // after the boot grant ends.
        const identityHook = (registerHooks) => {
          releaseBoot();
          if (fsGrant == null) return;
          // countinghouse's own, not the module's: logged here, not reported.
          const outside = fsGrant.bootOutside();
          if (outside.paths.length > 0) {
            LOG.I(`file broker: countinghouse's own boot looked outside its code (answered ENOENT): ${outside.paths.join(', ')}${
              outside.dropped > 0 ? ` and ${outside.dropped} more` : ''}`);
          }
          require('./fs-broker/identity').install({moduleRoot: fsWorkerData.moduleRoot, installDir: fsWorkerData.installDir,
            codeRoots: fsWorkerData.codeRoots,
            mode: options.moduleSandbox, grant: fsGrant, registerHooks: registerHooks,
            report: (rule, target) => wm.sendSandboxViolationToParent(rule, target)});
        };
        try {
          // Module sandbox: lock this worker down before any module code loads.
          // msg.sandbox is null under --moduleSandbox off.
          if (msg.sandbox != null) {
            require('./module-lockdown').install(Object.assign({}, msg.sandbox, fsGrant != null ? {virtualRoot: '/app'} : {}),
              (rule, target) => { wm.sendSandboxViolationToParent(rule, target); }, {beforeLock: identityHook});
          } else {
            identityHook(null);
          }
        } catch (e) {
          // countinghouse under /app (spec decision 12), or a lockdown that
          // could not install: the load fails with the reason.
          return wm.sendMessageToParent(msg.id, e, null);
        }
        return wm.sendMessageToParent(msg.id, null, null);
        break;
      }
      case 'sandbox-ping': {
        return wm.sendMessageToParent(msg.id, null, null);
      }
      // The main thread refused a message from this worker for another reason
      // (a validation worker asking for a main-thread service; review R1-4).
      case 'refused-reply': {
        const callback = wm.msgQueue[msg.msgID];
        if (typeof(callback) === 'function') {
          const err = new Error(msg.errMsg || 'refused by the main thread');
          err.code = msg.errCode || 'REFUSED';
          callback(err, null);
        }
        delete wm.msgQueue[msg.msgID];
        break;
      }
      // The main thread refused a message from this worker: --moduleMessageRate.
      case 'rate-limited-reply': {
        const id = msg.msgID;
        const callback = wm.msgQueue[id];
        if (typeof(callback) === 'function') {
          const err = new Error('too many messages to the main thread (--moduleMessageRate)');
          err.code = 'RATE_LIMITED';
          callback(err, null);
        }
        delete wm.msgQueue[id];
        break;
      }
      case 'set-composition': {
        // From DeviceManager.prototype.verifyComposition (main thread only),
        // relayed via WorkerMessage.prototype.sendSetCompositionMessage: the
        // composition handler-ctx's ctx.call reads, on this worker's device.
        const device = (dispatcher != null && dispatcher.device.deviceID === msg.deviceID) ? dispatcher.device : null;
        if (device == null) {
          // Never acked as landed when nothing happened: ctx.call would then
          // be unavailable with no trace of why.
          const err = new CountinghouseError('MODULE_COMPOSITION_INVALID', msg.deviceID,
            `set-composition relay targeted a deviceID this worker does not host: ${msg.deviceID}`);
          LOG.E(err);
          return wm.sendMessageToParent(msg.id, err, null);
        }
        const handlerCtx = require('./handler-ctx');
        // The device failed verification at startup and the main thread
        // purged it: release its waiting ctx.calls, unsettled.
        if (msg.release === true) { handlerCtx.releaseWaiters(device); return wm.sendMessageToParent(msg.id, null, null); }
        handlerCtx.setComposition(device,
          (msg.identity != null) ? {identity: msg.identity, allowed: msg.allowed} : null);
        return wm.sendMessageToParent(msg.id, null, null);
      }
      // countinghouse_validate_module: run the validator on /app, after the
      // lockdown, then the main thread discards this worker (review R1-4).
      // Here, in the module's own worker, never in a validator worker: it
      // runs the module's code, and no module code runs in a validator.
      case 'validate-module': {
        require('./module-validator').validateModule('/app', (err, result) => {
          return wm.sendMessageToParent(msg.id, err, result);
        });
        break;
      }
      // The module's handler files, required once: answered {loaded, deviceID,
      // names}, or the load's error (the main thread then ends this worker).
      case 'load-module': {
        if (dispatcher != null) {
          return wm.sendMessageToParent(msg.id, new CountinghouseError('LOAD_MODULE_FAIL', String(msg.name),
            `a worker runs one module, and this one runs ${dispatcher.device.moduleName}`), null);
        }
        let spec = null;
        try {
          spec = JSON.parse(fs.readFileSync(path.join(msg.path, 'api.json'), 'utf8'));
        } catch (e) {
          return wm.sendMessageToParent(msg.id, new CountinghouseError('LOAD_MODULE_FAIL', String(msg.name), `api.json: ${readField(e, 'message', 'unreadable')}`), null);
        }
        // The module's device config, read by the main thread and sent with
        // the load (lib/device-config.js's applyDeviceConfig, in a worker):
        // set before its handler files are required.
        global.DeviceConfig = (msg.deviceConfig == null) ? {} : JSON.parse(JSON.stringify(msg.deviceConfig));
        try {
          const d = createDispatcher({modulePath: msg.path, moduleName: msg.name, spec: spec, checkOutput: checkPeerOutput});
          d.modulePath = msg.path;
          dispatcher = d;
        } catch (e) {
          const err = (e instanceof CountinghouseError) ? e
            : new CountinghouseError('LOAD_MODULE_FAIL', String(msg.name), readField(e, 'message', 'an error with no message'));
          // at error level, naming the module, as a failed load always was
          LOG.E(new CountinghouseError('LOAD_MODULE_FAIL', String(msg.name), err.message));
          return wm.sendMessageToParent(msg.id, err, null);
        }
        wm.moduleName = msg.name;
        wm.modulePath = msg.path;
        return wm.sendMessageToParent(msg.id, null, {loaded: true, deviceID: dispatcher.device.deviceID, names: [...dispatcher.names]});
      }
      case 'unload-module': {
        // From here on, a request for this worker's device is answered with
        // why it ended: main may still forward one it received before its
        // own purge.
        endingCode = (msg.why === 'reload') ? 'MODULE_RELOADING' : 'MODULE_UNLOADED';
        return wm.sendMessageToParent(msg.id, null, null);
      }
      case 'invoke-action': {
        const answer = (err, data) => {
          let retData = data;

          if (typeof(data) === 'function') {
            err = new Error('Invoke fail');
            retData = {fault: 'Incorrect return data type', reason: 'Return function type to caller is not allowed'};
          } else if (err == null && data != null) {
            // The reply's size, measured here before it is posted (lean worker
            // step 1(b)): over --maxOutputBytes the main thread would pay to
            // post it on to a validator. One that cannot be serialised is left
            // to the reply's own fallback.
            let bytes = -1;
            try { bytes = v8Serialize(data).byteLength; } catch (e) { bytes = -1; }
            const max = options.maxOutputBytes;
            if (Number.isInteger(max) && bytes > max) {
              const moduleName = (dispatcher != null) ? dispatcher.device.moduleName : 'module';
              err = CountinghouseError.withFields('OUTPUT_TOO_LARGE', {module: moduleName, action: String(msg.actionName), bytes: bytes, max: max});
              retData = null;
            }
          }
          return wm.sendMessageToParent(msg.id, err, retData);
        };
        // msg.mainChecked: this call's input was checked, and its output is
        // checked on the reply, in a validator worker; only the main thread's
        // invoke says so.
        invokeHere(msg.deviceID, msg.serviceID, msg.actionName, msg.args, msg.mainChecked === true, answer);
        break;
      }
      //below *-reply messages are reply to child initiated message, so we take out callback object from message queue and call it
      case 'query-device-reply': {
        // message contains: {msgID: msgID, errMsg: errMsg, errCode?, spec: spec}
        const id = msg.msgID;

        if (wm.msgQueue[id] != null) {
          const callback = wm.msgQueue[id];
          if (callback != null && typeof(callback) === 'function') {
            if (msg.errMsg != null) {
              // with its code (R2-1 Task 3): a missing device's reason to an
              // identity granted it, or the access error
              callback(CountinghouseError.fromReplyFields(msg), null);
            } else {
              callback(null, msg.spec);
            }
            delete wm.msgQueue[id];
          }
        }
        break;
      }
      case 'invoke-action-reply': {
        // msg.platformMetering (D5) rides alongside msg.data as a 3rd,
        // additive callback arg -- see
        // DeviceManager.prototype.sendInvokeActionMessageToWorker's own
        // comment for why it's never merged into msg.data itself.
        //
        // msg.errCode mirrors lib/peer-channel.js's _handleReply (:202):
        // reattached to the reconstructed Error when present, so a rejected
        // ctx.call carries the same `.code` regardless of which cross-worker
        // path served it -- absent (msg.errCode == null) for an error that
        // never had one (e.g. a bare Error thrown by a handler), same as the
        // --directPeerChannels path. A callee module's error comes back as
        // the module's (CountinghouseError.fromReplyFields).
        const id = msg.msgID;
        if (wm.msgQueue[id] != null) {
          const callback = wm.msgQueue[id];
          if (callback != null && typeof(callback) === 'function') {
            if (msg.errMsg != null) {
              callback(CountinghouseError.fromReplyFields(msg), msg.data);
            } else {
              callback(null, msg.data, msg.platformMetering);
            }
            delete wm.msgQueue[id];
          }
        }
        break;
      }
      case 'device-log-reply': {
        const id = msg.msgID;

        if (wm.msgQueue[id] != null) {
          const callback = wm.msgQueue[id];
          if (callback != null && typeof(callback) === 'function') {
            if (msg.errMsg != null) {
              callback(new Error(msg.errMsg));
            } else {
              callback(null);
            }
            delete wm.msgQueue[id];
          }
        }
        break;
      }
      case 'redis-command-reply': {
        // message contains: {msgID: msgID, errMsg: errMsg, result: result}
        const id = msg.msgID;

        if (wm.msgQueue[id] != null) {
          const callback = wm.msgQueue[id];
          if (callback != null && typeof(callback) === 'function') {
            if (msg.errMsg != null) {
              callback(new Error(msg.errMsg), null);
            } else {
              callback(null, msg.result);
            }
            delete wm.msgQueue[id];
          }
        }
        break;
      }
      // RC1-min: the answer to ctx.call('remote:...'). A rejection keeps
      // its code (REMOTE_*, HOP_IDENTITY_UNRESOLVED) as a CountinghouseError,
      // so the module and lib/service.js see the runtime's own code.
      case 'remote-call-reply': {
        const id = msg.msgID;
        const callback = wm.msgQueue[id];
        if (typeof(callback) !== 'function') break;
        delete wm.msgQueue[id];
        if (msg.errMsg == null) {
          callback(null, msg.result);
        } else {
          // The shared decoder and hopError, as a device hop's reply: a
          // runtime code comes back as a CountinghouseError, so a handler that
          // rethrows answers with it, not DEVICE_INVOKE_EXCEPTION
          // (lib/service.js's fail). The message is kept: the main thread
          // wrote it, not a callee.
          const decoded = CountinghouseError.fromReplyFields(msg);
          const e = hopError(decoded);
          if (e !== decoded && e instanceof CountinghouseError) e.message = decoded.message;
          callback(e, null);
        }
        break;
      }
      case 'get-job-info-reply': {
        // message contains: {msgID: msgID, errMsg: errMsg, job: job}
        const id = msg.msgID;

        if (wm.msgQueue[id] != null) {
          const callback = wm.msgQueue[id];
          if (callback != null && typeof(callback) === 'function') {
            if (msg.errMsg != null) {
              callback(new Error(msg.errMsg), null);
            } else {
              callback(null, msg.job);
            }
            delete wm.msgQueue[id];
          }
        }
        break;
      }
      // direct peer channels (docs/direct-peer-channels-design.md) -- these
      // four are NOT correlated via wm.msgQueue/msg.msgID like the
      // *-reply cases above (peer-channel-request was sent fire-and-forget,
      // see WorkerMessage.prototype.sendPeerChannelRequestToParent); lib/peer-worker.js's
      // onPeerChannel* functions correlate by targetDeviceID/workerId
      // instead. See lib/peer-worker.js for the actual handling.
      case 'peer-channel-grant': {
        peerDm.onPeerChannelGrant(msg);
        break;
      }
      case 'peer-channel-deny': {
        peerDm.onPeerChannelDeny(msg);
        break;
      }
      case 'peer-announce-refused': {
        peerDm.onPeerAnnounceRefused(msg);
        break;
      }
      case 'peer-channel-open': {
        peerDm.onPeerChannelOpen(msg);
        break;
      }
      case 'peer-channel-allow': {
        peerDm.onPeerChannelAllow(msg);
        return wm.sendMessageToParent(msg.id, null, null);
      }
      case 'peer-invalidate': {
        peerDm.onPeerInvalidate(msg);
        break;
      }
      // Unlike the four above, this one *is* correlated via wm.msgQueue/
      // msg.msgID, same pattern as get-job-info-reply etc. above -- see
      // WorkerMessage.prototype.sendPeerMeteringRequestToParent.
      case 'peer-metering-reply': {
        // message contains: {msgID, errMsg, errCode?, meteringResult, token?}:
        // the error with its code (CALL_TOKEN_INVALID is a refusal to serve;
        // a deduction's failure is not), and the callee's own token for the
        // invoke (R2-1 Task 3)
        const id = msg.msgID;

        if (wm.msgQueue[id] != null) {
          const callback = wm.msgQueue[id];
          if (callback != null && typeof(callback) === 'function') {
            if (msg.errMsg != null) {
              callback(CountinghouseError.fromReplyFields(msg), null, msg.token);
            } else {
              // a bill still pending (the deduction past its bound) is said
              // so to the caller, as its platformMetering
              callback(null, (msg.meteringResult == null && msg.billingPending === true) ? {billingPending: true} : msg.meteringResult, msg.token);
            }
            delete wm.msgQueue[id];
          }
        }
        break;
      }
    }
  });
}
