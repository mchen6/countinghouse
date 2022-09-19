var fs = require('fs');
var com_apemesh_echoService_echo = CdifUtil.loadFile(__dirname + '/com-apemesh-echoService.js').com_apemesh_echoService_echo;
var com_apemesh_echoService_echoWithAPICache = CdifUtil.loadFile(__dirname + '/com-apemesh-echoService.js').com_apemesh_echoService_echoWithAPICache;
var com_apemesh_echoService_echoAsync = CdifUtil.loadFile(__dirname + '/com-apemesh-echoService.js').com_apemesh_echoService_echoAsync;
var com_apemesh_timeOutTestService_testTimeout = CdifUtil.loadFile(__dirname + '/com-apemesh-timeOutTestService.js').com_apemesh_timeOutTestService_testTimeout;
var com_apemesh_timeOutTestService_testTimeoutAsync = CdifUtil.loadFile(__dirname + '/com-apemesh-timeOutTestService.js').com_apemesh_timeOutTestService_testTimeoutAsync;
var com_apemesh_errorInfoTestService_testErrorInfo = CdifUtil.loadFile(__dirname + '/com-apemesh-errorInfoTestService.js').com_apemesh_errorInfoTestService_testErrorInfo;
var com_apemesh_errorInfoTestService_testFunctionReturnError = CdifUtil.loadFile(__dirname + '/com-apemesh-errorInfoTestService.js').com_apemesh_errorInfoTestService_testFunctionReturnError;
var com_apemesh_errorInfoTestService_testNullReturnError = CdifUtil.loadFile(__dirname + '/com-apemesh-errorInfoTestService.js').com_apemesh_errorInfoTestService_testNullReturnError;
var com_apemesh_errorInfoTestService_testNumberTypeReturnError = CdifUtil.loadFile(__dirname + '/com-apemesh-errorInfoTestService.js').com_apemesh_errorInfoTestService_testNumberTypeReturnError;
var com_apemesh_errorInfoTestService_testStringTypeReturnError = CdifUtil.loadFile(__dirname + '/com-apemesh-errorInfoTestService.js').com_apemesh_errorInfoTestService_testStringTypeReturnError;
var com_apemesh_errorInfoTestService_testBooleanTypeReturnError = CdifUtil.loadFile(__dirname + '/com-apemesh-errorInfoTestService.js').com_apemesh_errorInfoTestService_testBooleanTypeReturnError;
var com_apemesh_errorInfoTestService_testErrorInfoAsync = CdifUtil.loadFile(__dirname + '/com-apemesh-errorInfoTestService.js').com_apemesh_errorInfoTestService_testErrorInfoAsync;

function Device() {
  var spec = JSON.parse(fs.readFileSync(__dirname + '/api.json').toString());
  CdifDevice.call(this, spec);
  this.setAction('urn:apemesh-com:serviceID:echoService', 'echo', com_apemesh_echoService_echo.bind(this));
  this.setAction('urn:apemesh-com:serviceID:echoService', 'echoWithAPICache', com_apemesh_echoService_echoWithAPICache.bind(this));
  this.setAction('urn:apemesh-com:serviceID:echoService', 'echoAsync', com_apemesh_echoService_echoAsync.bind(this));
  this.setAction('urn:apemesh-com:serviceID:timeOutTestService', 'testTimeout', com_apemesh_timeOutTestService_testTimeout.bind(this));
  this.setAction('urn:apemesh-com:serviceID:timeOutTestService', 'testTimeoutAsync', com_apemesh_timeOutTestService_testTimeoutAsync.bind(this));
  this.setAction('urn:apemesh-com:serviceID:errorInfoTestService', 'testErrorInfo', com_apemesh_errorInfoTestService_testErrorInfo.bind(this));
  this.setAction('urn:apemesh-com:serviceID:errorInfoTestService', 'testFunctionReturnError', com_apemesh_errorInfoTestService_testFunctionReturnError.bind(this));
  this.setAction('urn:apemesh-com:serviceID:errorInfoTestService', 'testNullReturnError', com_apemesh_errorInfoTestService_testNullReturnError.bind(this));
  this.setAction('urn:apemesh-com:serviceID:errorInfoTestService', 'testNumberTypeReturnError', com_apemesh_errorInfoTestService_testNumberTypeReturnError.bind(this));
  this.setAction('urn:apemesh-com:serviceID:errorInfoTestService', 'testStringTypeReturnError', com_apemesh_errorInfoTestService_testStringTypeReturnError.bind(this));
  this.setAction('urn:apemesh-com:serviceID:errorInfoTestService', 'testBooleanTypeReturnError', com_apemesh_errorInfoTestService_testBooleanTypeReturnError.bind(this));
  this.setAction('urn:apemesh-com:serviceID:errorInfoTestService', 'testErrorInfoAsync', com_apemesh_errorInfoTestService_testErrorInfoAsync.bind(this));
  // console.log(JSON.stringify(DeviceConfig));
}

CdifUtil.inherits(Device, CdifDevice);

Device.prototype._getDeviceRootSchema = function() {
  return JSON.parse(fs.readFileSync(__dirname + '/schema.json').toString());
};

module.exports = Device;