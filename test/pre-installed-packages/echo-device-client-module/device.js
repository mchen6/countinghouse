var fs = require('fs');
var API名称 = CdifUtil.loadFile(__dirname + '/服务名称.js').API名称;

function Device() {
  var spec = JSON.parse(fs.readFileSync(__dirname + '/api.json').toString());
  CdifDevice.call(this, spec);
  this.setAction('urn:example-com:serviceID:服务名称', 'API名称', API名称.bind(this));
  
  CdifUtil.createServiceClient({
    deviceID: 'b752c14b-27ec-5374-a2ca-0ce71c247566',
    serviceID: 'urn:apemesh-com:serviceID:echoService',
    appKey: '***REDACTED-APPKEY***'
  }, (err, client) => {this.client = client});
}

CdifUtil.inherits(Device, CdifDevice);

Device.prototype._getDeviceRootSchema = function() {
  return JSON.parse(fs.readFileSync(__dirname + '/schema.json').toString());
};

module.exports = Device;
