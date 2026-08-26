// Never actually invoked: this module's countinghouse.calls names an action
// that does not exist on compose-callee, so DeviceManager.prototype.
// verifyComposition must fail this module's load before any handler runs.
module.exports = async () => ({output: {ok: true}});
