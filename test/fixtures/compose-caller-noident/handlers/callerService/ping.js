// Never actually invoked: this module declares countinghouse.calls but no
// auth identity's "runsModules" lists it, so DeviceManager.prototype.
// verifyComposition must fail this module's load before any handler runs.
module.exports = async () => ({output: {ok: true}});
