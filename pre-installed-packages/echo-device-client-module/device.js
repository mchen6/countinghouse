const fs = require('fs');
const API名称 = CHUtil.loadFile(`${__dirname}/服务名称.js`).API名称;
const testErrorInfo = CHUtil.loadFile(`${__dirname}/errTestService.js`).testErrorInfo;

function Device() {
  const spec = JSON.parse(fs.readFileSync(`${__dirname}/api.json`).toString());
  CHDevice.call(this, spec);
  this.setAction('urn:example-com:serviceID:服务名称', 'API名称', API名称.bind(this));
  this.setAction('urn:example-com:serviceID:errTestService', 'testErrorInfo', testErrorInfo.bind(this));

  CHUtil.createServiceClient({
    deviceID: 'c5284c70-ae5f-591c-b2f1-cf0b4ebd0767',
    serviceID: 'urn:countinghouse-com:serviceID:echoService',
    appKey: 'aabbcc'
  }, (err, client) => {this.client = client});

  CHUtil.createServiceClient({
    deviceID: 'c5284c70-ae5f-591c-b2f1-cf0b4ebd0767',
    serviceID: 'urn:countinghouse-com:serviceID:errorInfoTestService',
    appKey: 'aabbcc'
  }, (err, client) => {this.errorInfoTestclient = client});

  CHUtil.deviceLog(this, JSON.stringify(DeviceConfig));
}

CHUtil.inherits(Device, CHDevice);

Device.prototype._getDeviceRootSchema = function() {
  return JSON.parse(fs.readFileSync(`${__dirname}/schema.json`).toString());
};

module.exports = Device;