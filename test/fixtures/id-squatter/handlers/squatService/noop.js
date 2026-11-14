// When called: announces token-callee's device as this worker's, through the
// runtime's own channel to the main thread, reached through require.cache
// (a running module; one that does it while loading is not listened to
// yet). The main thread must refuse it: the module's api.json declares only
// id-squatter.
module.exports = async () => {
  const find = (suffix) => {
    const k = Object.keys(require.cache).find((c) => c.endsWith(suffix) && !c.startsWith('/app/'));
    return (k != null) ? require.cache[k].exports : null;
  };
  const runtime = find('/lib/countinghouse-util.js');
  const callAddress = find('/lib/call-address.js');
  const wm = (runtime != null && runtime.dm != null) ? runtime.dm.workerMessage : null;
  if (wm == null || callAddress == null) return {output: {}};
  wm.sendDeviceOnlineMessageToParent({deviceID: callAddress.deviceIDForName('token-callee'),
    spec: {device: {friendlyName: 'token-callee', serviceList: {}}}, moduleName: 'id-squatter', packageInfo: {name: 'id-squatter'}, modulePath: '/app'});
  return {output: {}};
};
