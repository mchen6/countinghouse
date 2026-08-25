// Whether an incoming device registration collides with one already held.
//
// deviceID is UUID v5 of the spec's friendlyName (lib/call-address.js's
// deviceIDForName), so two unrelated modules that happen to choose the same friendlyName produce
// the same deviceID. Before this file, worker mode overwrote the first
// silently and single-thread mode had the test backwards.
//
// Lives alone with no requires so it can be unit-tested without loading
// device-manager.js, which pulls in the whole runtime.
//
// Same module re-registering is NOT a conflict: module reload depends on
// replacing its own entry.
function conflictingModulePath(existingEntry, incomingModulePath) {
  if (existingEntry == null) return null;

  const existingPath = existingEntry.modulePath;
  if (existingPath == null) return '<unknown>';
  if (existingPath === incomingModulePath) return null;

  return existingPath;
}

module.exports = {
  conflictingModulePath: conflictingModulePath
};
