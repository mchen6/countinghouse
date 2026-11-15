'use strict';
// A counter of tool-set changes, in this thread: bumped whenever what
// tools/list and tools/call see may have changed (DeviceManager's
// toolsetChanged, a device's updateDeviceSpec). lib/mcp/tool-registry.js's
// tool table and its tools/call output schemas are kept only for the
// generation they were built in, so a change made in place (an
// updateDeviceSpec with the same spec object) is never missed.
let generation = 0;
module.exports = {
  bump() { generation += 1; },
  current: () => generation
};
