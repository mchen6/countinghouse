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

//TODO: consider replace bson with bson-ext native addon to increase message passing performance
const Worker         = require('worker_threads').Worker;
const isMainThread   = require('worker_threads').isMainThread;
const parentPort     = require('worker_threads').parentPort;

const options        = require('./cli-options');
// A worker is single-threaded inside; set-options (below) replaces these with
// the main thread's options, with workerThread forced false again.
options.setOptions({workerThread: false});

const LOG = require('./logger');
LOG.createLogger(false);

process.on('uncaughtException', (e) => {
  LOG.E(new Error(`Uncaught exception in worker thread: ${e.stack}`));
});

const ModuleManager = require('./module-manager');
const CdifInterface = require('./countinghouse-interface');

const mm = new ModuleManager();
//device manager instance is created inside cdifInterface
const ci = new CdifInterface(mm);

const dm = ci.deviceManager;

//use device-manager's workerMessage instance to receive message from parent
//each child thread should exactly have only this ONE workerMessage instance
const wm = dm.workerMessage;

const redisAPI        = require('./redis-api');
// Taken before the lockdown (set-options), which watches v8 from then on:
// the reply's size check (--maxOutputBytes) is the runtime's own use of it.
const v8Serialize     = require('v8').serialize;
// A hop's result crosses as bytes (lean worker step 2): made and read with
// V8's own serializer, loaded before the lockdown.
const {toArrayBuffer, serialize, decode} = require('./serialized-result');
const {CountinghouseError, hopError} = require('./countinghouse-error');
redisAPI.init(dm); //send in dm instance to get the workerMessage instance in it

// var WorkerMessage = require('./worker-message');
// var workerMessage = new WorkerMessage(null);
global.CHUtil     = require('./countinghouse-util');
global.CHDevice   = require('./countinghouse-device');

//manually set CHUtil.redis because when countinghouse-util.js is first time required, redis-api.js isn't loaded and initialized yet
global.CHUtil.redis = redisAPI.client;

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
        // From DeviceManager.prototype.verifyComposition (main thread only,
        // after discovery), relayed via WorkerMessage.prototype.
        // sendSetCompositionMessage. dm.deviceMap here is THIS worker's own
        // map, holding the real CHDevice buildCtx/ctx.call read _composition
        // off of -- not the WorkerMessage proxy the main thread sees.
        const device = dm.deviceMap[msg.deviceID];
        if (device == null) {
          // Must not ack success here: the main thread would then believe
          // this binding (or clearing) landed when nothing happened, and
          // the failure mode is "ctx.call is unavailable" with no
          // server-side trace pointing at why -- exactly what load-time
          // composition errors exist to prevent. Fail loudly instead.
          const err = new CountinghouseError('MODULE_COMPOSITION_INVALID', msg.deviceID,
            `set-composition relay targeted a deviceID this worker does not host: ${msg.deviceID}`);
          LOG.E(err);
          return wm.sendMessageToParent(msg.id, err, null);
        }
        const handlerCtx = require('./handler-ctx');
        // The device failed verification at startup and the main thread
        // purged it: release its waiting ctx.calls, unsettled, so they refuse
        // CTX_CALL_NOT_READY now rather than at the bound.
        if (msg.release === true) { handlerCtx.releaseWaiters(device); return wm.sendMessageToParent(msg.id, null, null); }
        handlerCtx.setComposition(device,
          (msg.identity != null) ? {identity: msg.identity, allowed: msg.allowed} : null);
        return wm.sendMessageToParent(msg.id, null, null);
        break;
      }
      // countinghouse_validate_module: run the validator on /app, after the
      // lockdown, then the main thread discards this worker (review R1-4).
      case 'validate-module': {
        require('./module-validator').validateModule('/app', (err, result) => {
          return wm.sendMessageToParent(msg.id, err, result);
        });
        break;
      }
      case 'load-module': {
        mm.loadModuleFromPath(msg.path, msg.name, msg.version, (err, mi) => {
          return wm.sendMessageToParent(msg.id, err, null);
        }, msg.deviceConfig);
        break;
      }
      case 'unload-module': {
        // From here on, a request for a device this worker no longer has is
        // answered with why it ended (DeviceManager's missingDeviceError):
        // main may still forward one it received before its own purge.
        ci.deviceManager.endingCode = (msg.why === 'reload') ? 'MODULE_RELOADING' : 'MODULE_UNLOADED';
        mm.unloadModuleExternal(msg.name, () => {
          return wm.sendMessageToParent(msg.id, null, null);
        });
        break;
      }
      case 'invoke-action': {
        const moduleName = () => {
          const device = ci.deviceManager.deviceMap[msg.deviceID];
          return (device != null && typeof(device.moduleName) === 'string') ? device.moduleName : 'module';
        };
        const max = options.maxOutputBytes;
        const tooLarge = (bytes) => CountinghouseError.withFields('OUTPUT_TOO_LARGE', {module: moduleName(), action: String(msg.actionName), bytes: bytes, max: max});
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
          try { buf = serialize(data); } catch (e) { buf = null; }
          if (buf == null) return postError(new CountinghouseError('DEVICE_INVOKE_EXCEPTION', 'the result could not be sent between threads'), null);
          if (Number.isInteger(max) && buf.byteLength > max) return postError(tooLarge(buf.byteLength), null);
          return wm.sendSerializedReplyToParent(msg.id, toArrayBuffer(buf));
        };
        const answer = (err, data) => {
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
            try { bytes = v8Serialize(data).byteLength; } catch (e) { bytes = -1; }
            if (Number.isInteger(max) && bytes > max) {
              err = tooLarge(bytes);
              retData = null;
            }
          }
          return wm.sendMessageToParent(msg.id, err, retData);
        };
        // This call's input was checked, and its output is checked on the
        // reply, in a validator worker (lib/validator-pool.js): this worker skips its own
        // validation. Only this message, the main thread's, says so; a direct
        // peer channel's call is validated here as before.
        if (msg.mainChecked === true) require('./service').markMainChecked(answer);
        // a hop's input arrives as bytes (lib/hop-input.js): decoded here
        let args = msg.args;
        try { args = require('./hop-input').decodeArgs(msg.args); } catch (e) { return answer(e, null); }
        ci.invokeDeviceAction(msg.deviceID, msg.serviceID, msg.actionName, args, answer);
        break;
      }
      case 'get-spec': {
        ci.getDeviceSpec(msg.deviceID, (err, data) => {
          return wm.sendMessageToParent(msg.id, err, data);
        });
        break;
      }
      case 'get-schema': {
        ci.getDeviceSchema(msg.deviceID, msg.path, (err, data) => {
          return wm.sendMessageToParent(msg.id, err, data);
        });
        break;
      }
      case 'discover-device': {
        // Answered once this worker's modules have reported their device, or
        // at the hold for one whose device never came online (lib/module-manager.js
        // whenDiscovered). A module reports after its device's online message
        // is sent (device-manager.js onDeviceOnline), so the parent has the
        // device before this answer. Listening starts before discover.
        require('./module-manager').whenDiscovered(ci.deviceManager.moduleManager.modules, () => {
          ci.stopDiscoverAll(() => {});
          return wm.sendMessageToParent(msg.id, null, null);
        });
        ci.discoverAll(() => {});
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
      // see WorkerMessage.prototype.sendPeerChannelRequestToParent); dm's
      // own onPeerChannel* methods correlate by targetDeviceID/workerId
      // instead. See lib/device-manager.js for the actual handling.
      case 'peer-channel-grant': {
        dm.onPeerChannelGrant(msg);
        break;
      }
      case 'peer-channel-deny': {
        dm.onPeerChannelDeny(msg);
        break;
      }
      case 'peer-announce-refused': {
        dm.onPeerAnnounceRefused(msg);
        break;
      }
      case 'peer-channel-open': {
        dm.onPeerChannelOpen(msg);
        break;
      }
      case 'peer-channel-allow': {
        dm.onPeerChannelAllow(msg);
        return wm.sendMessageToParent(msg.id, null, null);
      }
      case 'peer-invalidate': {
        dm.onPeerInvalidate(msg);
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

