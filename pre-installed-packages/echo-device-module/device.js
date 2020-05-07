var fs = require('fs');
var echo = CdifUtil.loadFile(__dirname + '/echoService.js').echo;
var testTimeout = CdifUtil.loadFile(__dirname + '/timeOutTestService.js').testTimeout;
var testErrorInfo = CdifUtil.loadFile(__dirname + '/errorInfoTestService.js').testErrorInfo;
var testFunctionReturnError = CdifUtil.loadFile(__dirname + '/errorInfoTestService.js').testFunctionReturnError;
var testNullReturnError = CdifUtil.loadFile(__dirname + '/errorInfoTestService.js').testNullReturnError;
var testNumberTypeReturnError = CdifUtil.loadFile(__dirname + '/errorInfoTestService.js').testNumberTypeReturnError;
var testStringTypeReturnError = CdifUtil.loadFile(__dirname + '/errorInfoTestService.js').testStringTypeReturnError;
var testBooleanTypeReturnError = CdifUtil.loadFile(__dirname + '/errorInfoTestService.js').testBooleanTypeReturnError;

function Device() {
  var spec = JSON.parse(fs.readFileSync(__dirname + '/api.json').toString());
  CdifDevice.call(this, spec);
  this.setAction('urn:apemesh-com:serviceID:echoService', 'echo', echo.bind(this));
  this.setAction('urn:apemesh-com:serviceID:timeOutTestService', 'testTimeout', testTimeout.bind(this));
  this.setAction('urn:apemesh-com:serviceID:errorInfoTestService', 'testErrorInfo', testErrorInfo.bind(this));
  this.setAction('urn:apemesh-com:serviceID:errorInfoTestService', 'testFunctionReturnError', testFunctionReturnError.bind(this));
  this.setAction('urn:apemesh-com:serviceID:errorInfoTestService', 'testNullReturnError', testNullReturnError.bind(this));
  this.setAction('urn:apemesh-com:serviceID:errorInfoTestService', 'testNumberTypeReturnError', testNumberTypeReturnError.bind(this));
  this.setAction('urn:apemesh-com:serviceID:errorInfoTestService', 'testStringTypeReturnError', testStringTypeReturnError.bind(this));
  this.setAction('urn:apemesh-com:serviceID:errorInfoTestService', 'testBooleanTypeReturnError', testBooleanTypeReturnError.bind(this));
}

CdifUtil.inherits(Device, CdifDevice);

Device.prototype._getDeviceRootSchema = function() {
  return JSON.parse(fs.readFileSync(__dirname + '/schema.json').toString());
};

module.exports = Device;