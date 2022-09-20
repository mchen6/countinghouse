var fs = require('fs');
var API名称 = CdifUtil.loadFile(__dirname + '/服务名称.js').API名称;
var testErrorInfo = CdifUtil.loadFile(__dirname + '/errTestService.js').testErrorInfo;

function Device() {
  var spec = JSON.parse(fs.readFileSync(__dirname + '/api.json').toString());
  CdifDevice.call(this, spec);
  this.setAction('urn:example-com:serviceID:服务名称', 'API名称', API名称.bind(this));
  this.setAction('urn:example-com:serviceID:errTestService', 'testErrorInfo', testErrorInfo.bind(this));

  CdifUtil.createServiceClient({
    deviceID: 'c5284c70-ae5f-591c-b2f1-cf0b4ebd0767',
    serviceID: 'urn:apemesh-com:serviceID:echoService',
    appKey: 'aabbcc'
  }, (err, client) => {this.client = client});

  CdifUtil.createServiceClient({
    deviceID: 'c5284c70-ae5f-591c-b2f1-cf0b4ebd0767',
    serviceID: 'urn:apemesh-com:serviceID:errorInfoTestService',
    appKey: 'aabbcc'
  }, (err, client) => {this.errorInfoTestclient = client});

  CdifUtil.deviceLog(this, JSON.stringify(DeviceConfig));
}

CdifUtil.inherits(Device, CdifDevice);

Device.prototype._getDeviceRootSchema = function() {
  return JSON.parse(fs.readFileSync(__dirname + '/schema.json').toString());
};

module.exports = Device;