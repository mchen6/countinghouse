'use strict';
// A per-session module's listing record (R1; #236 section 4a; the
// Reviewer's P1/P2): what stands for the module in the module map and its
// device in the device map on the shared runtime, with no worker of its own.
// Its spec was built and checked at the load as any module's is
// (lib/module-spec.js), and the listings read it as they read a worker's
// proxy (deviceList, packageInfo, moduleName, modulePath). Calls reach the
// calling session's own worker (lib/session-workers.js) through
// DeviceManager's workerFor. Any site that still takes the device map's
// entry as a worker finds this, not a WorkerMessage, and answers as for a
// device not hosted (ensureDeviceState): fail closed.
//
// It owns the spec: a session worker's exit doesn't release it, the
// record's unload does. It keeps the composition verdict too (bindings, and
// the messages a worker is told it by), so a session worker spawned later
// gets the module's verdict before it serves a call.
const {EventEmitter} = require('events');

class SessionModuleRecord extends EventEmitter {
  constructor({name, version, modulePath, moduleSpec, hostPackageInfo, hostDeviceIDs}) {
    super();
    this.perSession = true;
    this.hostModuleName = name;
    this.hostModulePath = modulePath;
    this.hostPackageInfo = hostPackageInfo;
    this.hostDeviceIDs = hostDeviceIDs;
    this.version = version;
    this.moduleSpec = moduleSpec;
    this.deviceList = {};
    this.online = true;
    this.discoverState = 'stopped';
    // deviceID -> the binding a token issued for the device's calls
    // authorizes as (call-tokens bindingOf): one object, shared with every
    // session worker, so clearing it (a failed re-verification) reaches all
    this.bindings = {};
    // deviceID -> the set-composition message each session worker is sent
    this.verdicts = {};
    // an unload or reload under way: no session worker starts
    this.closing = false;
    this.unloading = false;
    this.ended = null;
  }
}

const isRecord = (x) => x instanceof SessionModuleRecord;

module.exports = {SessionModuleRecord, isRecord};
