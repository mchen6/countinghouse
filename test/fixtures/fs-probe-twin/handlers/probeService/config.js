// config.js -- returns the module's device config.
module.exports = async () => ({output: {config: global.DeviceConfig == null ? null : global.DeviceConfig}});
