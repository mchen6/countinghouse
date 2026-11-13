// A module in the retired CDIF style: package.json "main" names this file, a
// CHDevice subclass, and there is no handlers/ directory. It is refused before
// any of its code runs (MODULE_LAYOUT_UNSUPPORTED, lib/module-layout.js):
// test/module-loading/01 case A and test/module-authoring/01.
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
