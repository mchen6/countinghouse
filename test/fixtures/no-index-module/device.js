// Deliberately-invalid fixture for test/module-loading/01-load-failure-diagnostics.js.
// Structurally a correct module (index.js present, CHDevice subclass) -- the
// only thing wrong is api.json, so this exercises the validateDeviceSpec stage.
const fs = require('fs');
function Device() {
  const spec = JSON.parse(fs.readFileSync(`${__dirname}/api.json`).toString());
  CHDevice.call(this, spec);
}
CHUtil.inherits(Device, CHDevice);
Device.prototype._getDeviceRootSchema = function() {
  return JSON.parse(fs.readFileSync(`${__dirname}/schema.json`).toString());
};
module.exports = Device;
