'use strict';
//workaround worker thread issue which didn't set process.umask as a function
process.umask = function() {};

// File broker (module sandbox part 2): patch fs before anything else
// loads, so nothing in this worker holds an unbrokered fs.
// taken at load, before any module code (the sandbox report path, below)
const ReflectApplyAtLoad = Reflect.apply;
const fsWorkerData = require('worker_threads').workerData || {};
// The loader's grant controller (lib/fs-broker/patch.js): kept here, out of
// reach of module code, and handed to the loader hook at set-options.
let fsGrant = null;
// the lockdown's handle (install), for the main thread's later denied addresses
let lockdown = null;
// countinghouse's own boot requires read its code with the original fs until
// set-options; no module code runs before then (review C1).
let releaseBoot = () => {};
if (fsWorkerData.fsBridge != null) {
  // Loaded now, under the boot grant: set-options installs it after the grant ends.
  require('./fs-broker/identity');
  fsGrant = require('./fs-broker/patch').install(require('./fs-broker/client').createClient(fsWorkerData.fsBridge)).grant;
  // countinghouse's code roots from the main thread (identity.codeRootsFor):
  // each under the spelling it runs by and its real path (#272).
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
// that logs nothing never loads it. Its records go to the main thread as
// messages, not to stdout (lib/worker-logger.js, #190).
// lib/logger.js makes the worker's on the first line logged.
// A line that cannot be logged (the logger itself failing to load, say) is
// lost, never thrown: a log call sits beside replies the main thread is
// waiting for, and a throw there would leave a load or a call unanswered.
const log = () => require('./logger');
const LOG = {
  E: (e) => { try { log().E(e); } catch (logErr) { /* the line is lost; the reply still goes */ } },
  I: (line) => { try { log().I(line); } catch (logErr) { /* the line is lost; the reply still goes */ } }
};

// The error is the module's: its stack is read once, cut, and anything it
// throws in the reading (a getter, a toString) is not let out of here.
const UNCAUGHT_MAX = 8192;
process.on('uncaughtException', (e) => {
  let text;
  try {
    text = String((e != null && typeof(e) === 'object') ? e.stack : e);
  } catch (readErr) {
    text = '(an error whose stack could not be read)';
  }
  if (text.length > UNCAUGHT_MAX) text = `${text.slice(0, UNCAUGHT_MAX)}... (${text.length} characters)`;
  try { LOG.E(new Error(`Uncaught exception in worker thread: ${text}`)); } catch (logErr) { /* nothing left to tell it with */ }
});

const WorkerMessage   = require('./worker-message');
// this worker's ONE WorkerMessage: replies to the main thread, and the
// queue its *-reply messages settle
const wm = new WorkerMessage(null);
// A hop's result crosses as bytes (lean worker step 2): made and read with
// V8's own serializer, loaded before the lockdown (set-options), which
// watches v8 from then on; the reply's size check (--maxOutputBytes) and the
// OUTPUT_NOT_JSON check use it too.
const {toArrayBuffer, serialize, serializeOutput, NotJson, notJsonError, decode} = require('./serialized-result');
const {CountinghouseError, hopError} = require('./countinghouse-error');
const {createDispatcher} = require('./lean-dispatcher');
const {readField}     = require('./handler-answer');
const chutilFacade    = require('./chutil-facade');

// The worker's peer state (lib/peer-worker.js runs with it as `this`), and
// what CHUtil and ServiceClient reach as CHUtil.dm: the worker's
// WorkerMessage, its hop to the main thread, its peer channels. The peer
// functions are loaded on first use: a worker that never opens a channel
// never loads them.
const PEER_METHODS = ['invokeActionViaPeerChannel', 'requestPeerChannel', 'onPeerChannelGrant', 'onPeerAnnounceRefused', 'onPeerChannelDeny',
  'flushPendingPeerInvokes', 'onPeerChannelOpen', 'onPeerChannelAllow', 'onPeerInvalidate', 'onPeerResult'];
const peerDm = Object.assign({}, {
  peerChannels:        {},
  peerDeviceWorkerMap: {},
  pendingPeerInvokes:  {},
  workerMessage:       wm,
  // a worker's hop names no identity or billing key (R2-1 Task 5)
  sendActionInvokeMessageToParent(deviceID, serviceID, actionName, args, callback) {
    return wm.sendActionInvokeMessageToParent(deviceID, serviceID, actionName, args, callback);
  },
  // the main thread's event path only; a worker queries over its WorkerMessage
  emit() { return false; },
  // a peer channel's callee side serves an invoke with this
  // (lib/peer-worker.js): its input was checked in a validator, and its
  // output is checked there on the bill request (lean worker step 4)
  invokeDeviceAction(deviceID, serviceID, actionName, args, callback) {
    return invokeHere(deviceID, serviceID, actionName, args, true, callback);
  },
  // the module this worker runs, for a peer channel's refusal text
  moduleName() { return (dispatcher != null) ? dispatcher.device.moduleName : 'module'; }
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
// invokeDeviceAction. Its input and output are checked by the main thread in
// a validator, as every call's are (lean worker step 4): none is validated
// in this worker.
const leanCi = {
  deviceManager: peerDm,
  invokeDeviceAction(deviceID, serviceID, actionName, args, callback) {
    return invokeHere(deviceID, serviceID, actionName, args, true, callback);
  }
};

// countinghouse-util is attached to this worker when it is first loaded,
// through lib/chutil-facade.js's runtime() (the facade, handler-ctx, the peer
// side): its dm, its ci and its Redis bridge. The module's global CHUtil is
// the facade, installed before set-options locks its routes out.
// countinghouse-util and what it requires make the logger on their first line
// logged, and the Redis bridge is made on its first use (CHUtil.redis,
// ctx.redis): a hop costs what the module uses, never the logger and the
// Redis client for a module that touches neither.
global.CHUtil = chutilFacade.createFacade(() => {
  // made once: an init that throws says so on that first read, and later
  // reads find no bridge rather than set it up again
  let made = false;
  let redis = null;
  const redisOf = () => {
    if (!made) {
      made = true;
      const redisAPI = require('./redis-api');
      redisAPI.init(peerDm);
      redis = redisAPI.client;
    }
    return redis;
  };
  return {dm: peerDm, ci: leanCi, redis: redisOf};
});

function invokeHere(deviceID, serviceID, actionName, args, mainChecked, callback) {
  if (dispatcher == null || deviceID !== dispatcher.device.deviceID) {
    return callback((endingCode != null) ? new CountinghouseError(endingCode, deviceID) : new CountinghouseError('DEVICE_NOT_FOUND', deviceID), null);
  }
  if (endingCode != null) return callback(new CountinghouseError(endingCode, deviceID), null);
  // every call is checked outside this worker: by the main thread's
  // validators (mainChecked), or, for a module the main thread holds no
  // spec for, not at all, as before
  return dispatcher.invoke(serviceID, actionName, args, mainChecked === true, callback);
}

// Every callback the runtime dispatches from a port runs in a scope of its
// own (lib/port-scope.js): module code called from it, a reply's callback
// among them, never finds the port as executionAsyncResource().
const {onPortMessage} = require('./port-scope');

if (!isMainThread) {
  onPortMessage(parentPort, (msg) => {
    switch (msg.command) {
      case 'set-options': {
        // MUST disable options.workerThread here because this flag is enabled only in main thread
        // or else main thread will recursively run the load module path
        msg.options.workerThread = false;
        // the main thread's options, resolved: durations in ms (#112)
        options.setResolvedOptions(msg.options);
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
        // the report path, taken now, before module code: never a method a
        // module could replace through the require cache
        const sendViolationOf = wm.sendSandboxViolationToParent;
        const sendViolation = (rule, target) => ReflectApplyAtLoad(sendViolationOf, wm, [rule, target]);
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
            virtualDrive: fsWorkerData.virtualDrive,
            codeRoots: fsWorkerData.codeRoots,
            mode: options.moduleSandbox, grant: fsGrant, registerHooks: registerHooks,
            report: sendViolation});
        };
        try {
          // Module sandbox: lock this worker down before any module code loads.
          // msg.sandbox is null under --moduleSandbox off.
          if (msg.sandbox != null) {
            lockdown = require('./module-lockdown').install(Object.assign({}, msg.sandbox, fsGrant != null ? {virtualRoot: '/app', virtualDrive: fsWorkerData.virtualDrive} : {}),
              sendViolation, {beforeLock: identityHook});
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
      // a live setting (lib/settings-tool.js broadcastLiveOptions): only its
      // fields, nothing else of the options
      case 'live-options': {
        require('./settings-tool').applyLiveOptions(options, msg.options);
        return;
      }
      // the Redis host name's addresses, resolved again by the main thread
      // (#207): added to this worker's denied ones, never removed
      case 'denied-addresses': {
        if (lockdown != null && typeof(lockdown.denyAddresses) === 'function') lockdown.denyAddresses(msg.addresses, msg.port);
        return;
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
          const d = createDispatcher({modulePath: msg.path, moduleName: msg.name, spec: spec});
          d.modulePath = msg.path;
          dispatcher = d;
        } catch (e) {
          const err = (e instanceof CountinghouseError) ? e
            : new CountinghouseError('LOAD_MODULE_FAIL', String(msg.name), readField(e, 'message', 'an error with no message'));
          // answered first, then logged at error level, naming the module, as
          // a failed load always was
          const answered = wm.sendMessageToParent(msg.id, err, null);
          LOG.E(new CountinghouseError('LOAD_MODULE_FAIL', String(msg.name), err.message));
          return answered;
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
        const moduleName = () => peerDm.moduleName();
        // the call's own cap and timeout, as the main thread sent them with it
        // (lib/call-limits.js), held by its token while it runs (its hops and
        // the handler's waits take them); the main thread's checks are the
        // guarantee, this is the early answer
        const callLimits = require('./call-limits');
        const given = callLimits.check(msg.limits);
        const callToken = (msg.args != null && typeof(msg.args.token) === 'string') ? msg.args.token : null;
        callLimits.remember(callToken, given);
        // a bounded override (a job of an ended session) taken now, as of() does
        const limits = given != null ? callLimits.of({limits: given}) : callLimits.defaults();
        const max = limits.maxOutputBytes;
        const tooLarge = (bytes) => CountinghouseError.withFields('OUTPUT_TOO_LARGE', {module: moduleName(), action: String(msg.actionName), bytes: bytes, max: max,
          raise: callLimits.raiseHint(bytes)});
        // A reply the main thread asked for as bytes (serializedReply: every
        // call whose spec it holds, lean worker step 2 and the review of
        // #165): the result, or the error and its payload, serialized once and
        // posted with the buffer transferred. The size checked here is only
        // the early answer: the main thread checks the bytes' own length, so
        // a getter, a patched byteLength or a huge fault cannot get past it.
        const postError = (err, data) => {
          let buf = null;
          try { buf = serialize({fields: CountinghouseError.replyFields(err), data: (data === undefined) ? null : data}); } catch (e) { buf = null; }
          if (buf == null) buf = serialize({fields: CountinghouseError.replyFields(new CountinghouseError('DEVICE_INVOKE_EXCEPTION', 'the error could not be sent between threads')), data: null});
          if (Number.isInteger(max) && buf.byteLength > max) buf = serialize({fields: CountinghouseError.replyFields(tooLarge(buf.byteLength)), data: null});
          return wm.sendSerializedErrorToParent(msg.id, toArrayBuffer(buf));
        };
        const postBytes = (err, data) => {
          if (err != null) return postError(err, data);
          let buf = null;
          try {
            buf = serializeOutput(data);
          } catch (e) {
            if (e instanceof NotJson) return postError(notJsonError(e, data, moduleName(), msg.actionName), null);
            buf = null;
          }
          if (buf == null) return postError(new CountinghouseError('DEVICE_INVOKE_EXCEPTION', 'the result could not be sent between threads'), null);
          if (Number.isInteger(max) && buf.byteLength > max) return postError(tooLarge(buf.byteLength), null);
          return wm.sendSerializedReplyToParent(msg.id, toArrayBuffer(buf));
        };
        const answer = (err, data) => {
          callLimits.forget(callToken);
          let retData = data;

          if (typeof(data) === 'function') {
            err = new Error('Invoke fail');
            retData = {fault: 'Incorrect return data type', reason: 'Return function type to caller is not allowed'};
          }
          if (msg.serializedReply === true) return postBytes(err, retData);
          // Otherwise (no spec on the main thread): the reply's size, measured
          // here before it is posted (lean worker step 1(b)); one that cannot
          // be serialised is left to the reply's own fallback.
          if (err == null && data != null && typeof(data) !== 'function') {
            let bytes = -1;
            try {
              bytes = serializeOutput(data).byteLength;
            } catch (e) {
              if (e instanceof NotJson) return wm.sendMessageToParent(msg.id, notJsonError(e, data, moduleName(), msg.actionName), null);
              bytes = -1;
            }
            if (Number.isInteger(max) && bytes > max) {
              err = tooLarge(bytes);
              retData = null;
            }
          }
          return wm.sendMessageToParent(msg.id, err, retData);
        };
        // msg.mainChecked: this call's input was checked, and its output is
        // checked on the reply, in a validator worker; only the main thread's
        // invoke says so. A hop's input arrives as bytes (lib/hop-input.js):
        // decoded here.
        let args = msg.args;
        try { args = require('./hop-input').decodeArgs(msg.args); } catch (e) { return answer(e, null); }
        invokeHere(msg.deviceID, msg.serviceID, msg.actionName, args, msg.mainChecked === true, answer);
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
            } else if (msg.dataBuffer instanceof ArrayBuffer) {
              // A hop's result as bytes (lean worker step 2): a validator has
              // checked them against the callee's output schema, and they are
              // within --maxOutputBytes (lib/device-manager.js sendCounted).
              let value;
              try {
                value = decode(msg.dataBuffer);
              } catch (e) {
                delete wm.msgQueue[id];
                callback(e, null);
                break;
              }
              callback(null, value, msg.platformMetering);
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
      // RC1-min: the answer to ctx.call('remote:...'), and to ctx.usage()
      // (usage-query-reply), decoded alike. A rejection keeps
      // its code (REMOTE_*, HOP_IDENTITY_UNRESOLVED) as a CountinghouseError,
      // so the module and lib/service.js see the runtime's own code.
      // and to ctx.ask() (ask-reply): its ASK_PENDING, ASK_UNAVAILABLE and
      // ASK_NOT_DECLARED come back as the runtime's own
      case 'remote-call-reply':
      case 'ask-reply':
      case 'usage-query-reply': {
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
      // the main thread's answer to an invoke this worker announced (lean
      // worker step 4): the callee no longer answers over the port
      case 'peer-result': {
        peerDm.onPeerResult(msg);
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
              // so to the caller, as its platformMetering; msg.caller is the
              // hop's caller as the callee's ctx shows it (R2-1 Task 5)
              // msg.inputBytes: a peer invoke's input as the validator passed
              // it, handed back for the handler (lean worker step 4)
              // and msg.target, the invoke's target as the caller announced it
              callback(null, (msg.meteringResult == null && msg.billingPending === true) ? {billingPending: true} : msg.meteringResult, msg.token, msg.caller, msg.inputBytes, msg.target);
            }
            delete wm.msgQueue[id];
          }
        }
        break;
      }
    }
  });
}
