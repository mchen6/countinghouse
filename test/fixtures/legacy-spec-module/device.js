// Fixture for test/module-loading/01-load-failure-diagnostics.js case C.
// Structurally a correct module -- the only thing wrong is that api.json is
// still in the pre-5.0.0 spec format, which is what the loader must say.
var fs = require('fs');
function Device() {
  var spec = JSON.parse(fs.readFileSync(__dirname + '/api.json').toString());
  CHDevice.call(this, spec);
}
CHUtil.inherits(Device, CHDevice);
Device.prototype._getDeviceRootSchema = function() {
  return JSON.parse(fs.readFileSync(__dirname + '/schema.json').toString());
};
module.exports = Device;
