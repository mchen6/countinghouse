// Lean worker step 3 (test/module-loading/27): another device's log, named by the module.
module.exports = async (input) => { CHUtil.deviceLog({deviceID: input.other}, {marker: input.marker}); return {output: {}}; };
