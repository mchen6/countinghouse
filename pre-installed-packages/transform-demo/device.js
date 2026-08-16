const fs = require('fs');
const com_countinghouse_transformService_uppercase = CHUtil.loadFile(`${__dirname}/com-countinghouse-transformService-uppercase.js`);

function Device() {
  const spec = JSON.parse(fs.readFileSync(`${__dirname}/api.json`).toString());
  CHDevice.call(this, spec);
  this.setAction('urn:countinghouse-com:serviceID:transformService', 'uppercase', com_countinghouse_transformService_uppercase.bind(this));
}

CHUtil.inherits(Device, CHDevice);

Device.prototype._getDeviceRootSchema = function() {
  return JSON.parse(fs.readFileSync(`${__dirname}/schema.json`).toString());
};

module.exports = Device;
