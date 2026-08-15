var fs = require('fs');
var com_countinghouse_echoService_echo = CHUtil.loadFile(__dirname + '/com-countinghouse-echoService.js').com_countinghouse_echoService_echo;
var com_countinghouse_echoService_echoAsync = CHUtil.loadFile(__dirname + '/com-countinghouse-echoService.js').com_countinghouse_echoService_echoAsync;
var com_countinghouse_timeOutTestService_testTimeout = CHUtil.loadFile(__dirname + '/com-countinghouse-timeOutTestService.js').com_countinghouse_timeOutTestService_testTimeout;
var com_countinghouse_timeOutTestService_testTimeoutAsync = CHUtil.loadFile(__dirname + '/com-countinghouse-timeOutTestService.js').com_countinghouse_timeOutTestService_testTimeoutAsync;
var com_countinghouse_errorInfoTestService_testErrorInfo = CHUtil.loadFile(__dirname + '/com-countinghouse-errorInfoTestService.js').com_countinghouse_errorInfoTestService_testErrorInfo;
var com_countinghouse_errorInfoTestService_testFunctionReturnError = CHUtil.loadFile(__dirname + '/com-countinghouse-errorInfoTestService.js').com_countinghouse_errorInfoTestService_testFunctionReturnError;
var com_countinghouse_errorInfoTestService_testNullReturnError = CHUtil.loadFile(__dirname + '/com-countinghouse-errorInfoTestService.js').com_countinghouse_errorInfoTestService_testNullReturnError;
var com_countinghouse_errorInfoTestService_testNumberTypeReturnError = CHUtil.loadFile(__dirname + '/com-countinghouse-errorInfoTestService.js').com_countinghouse_errorInfoTestService_testNumberTypeReturnError;
var com_countinghouse_errorInfoTestService_testStringTypeReturnError = CHUtil.loadFile(__dirname + '/com-countinghouse-errorInfoTestService.js').com_countinghouse_errorInfoTestService_testStringTypeReturnError;
var com_countinghouse_errorInfoTestService_testBooleanTypeReturnError = CHUtil.loadFile(__dirname + '/com-countinghouse-errorInfoTestService.js').com_countinghouse_errorInfoTestService_testBooleanTypeReturnError;
var com_countinghouse_errorInfoTestService_testErrorInfoAsync = CHUtil.loadFile(__dirname + '/com-countinghouse-errorInfoTestService.js').com_countinghouse_errorInfoTestService_testErrorInfoAsync;
var com_countinghouse_errorInfoTestService_testThrowError = CHUtil.loadFile(__dirname + '/com-countinghouse-errorInfoTestService.js').com_countinghouse_errorInfoTestService_testThrowError;
var com_countinghouse_errorInfoTestService_testThrowErrorAsync = CHUtil.loadFile(__dirname + '/com-countinghouse-errorInfoTestService.js').com_countinghouse_errorInfoTestService_testThrowErrorAsync;
var com_countinghouse_errorInfoTestService_testAsyncThrowInDomain = CHUtil.loadFile(__dirname + '/com-countinghouse-errorInfoTestService.js').com_countinghouse_errorInfoTestService_testAsyncThrowInDomain;
var com_countinghouse_errorInfoTestService_testAsyncThrowInAsync = CHUtil.loadFile(__dirname + '/com-countinghouse-errorInfoTestService.js').com_countinghouse_errorInfoTestService_testAsyncThrowInAsync;

function Device() {
  var spec = JSON.parse(fs.readFileSync(__dirname + '/api.json').toString());
  CHDevice.call(this, spec);
  this.setAction('urn:countinghouse-com:serviceID:echoService', 'echo', com_countinghouse_echoService_echo.bind(this));
  this.setAction('urn:countinghouse-com:serviceID:echoService', 'echoAsync', com_countinghouse_echoService_echoAsync.bind(this));
  this.setAction('urn:countinghouse-com:serviceID:timeOutTestService', 'testTimeout', com_countinghouse_timeOutTestService_testTimeout.bind(this));
  this.setAction('urn:countinghouse-com:serviceID:timeOutTestService', 'testTimeoutAsync', com_countinghouse_timeOutTestService_testTimeoutAsync.bind(this));
  this.setAction('urn:countinghouse-com:serviceID:errorInfoTestService', 'testErrorInfo', com_countinghouse_errorInfoTestService_testErrorInfo.bind(this));
  this.setAction('urn:countinghouse-com:serviceID:errorInfoTestService', 'testFunctionReturnError', com_countinghouse_errorInfoTestService_testFunctionReturnError.bind(this));
  this.setAction('urn:countinghouse-com:serviceID:errorInfoTestService', 'testNullReturnError', com_countinghouse_errorInfoTestService_testNullReturnError.bind(this));
  this.setAction('urn:countinghouse-com:serviceID:errorInfoTestService', 'testNumberTypeReturnError', com_countinghouse_errorInfoTestService_testNumberTypeReturnError.bind(this));
  this.setAction('urn:countinghouse-com:serviceID:errorInfoTestService', 'testStringTypeReturnError', com_countinghouse_errorInfoTestService_testStringTypeReturnError.bind(this));
  this.setAction('urn:countinghouse-com:serviceID:errorInfoTestService', 'testBooleanTypeReturnError', com_countinghouse_errorInfoTestService_testBooleanTypeReturnError.bind(this));
  this.setAction('urn:countinghouse-com:serviceID:errorInfoTestService', 'testErrorInfoAsync', com_countinghouse_errorInfoTestService_testErrorInfoAsync.bind(this));
  this.setAction('urn:countinghouse-com:serviceID:errorInfoTestService', 'testThrowError', com_countinghouse_errorInfoTestService_testThrowError.bind(this));
  this.setAction('urn:countinghouse-com:serviceID:errorInfoTestService', 'testThrowErrorAsync', com_countinghouse_errorInfoTestService_testThrowErrorAsync.bind(this));
  this.setAction('urn:countinghouse-com:serviceID:errorInfoTestService', 'testAsyncThrowInDomain', com_countinghouse_errorInfoTestService_testAsyncThrowInDomain.bind(this));
  this.setAction('urn:countinghouse-com:serviceID:errorInfoTestService', 'testAsyncThrowInAsync', com_countinghouse_errorInfoTestService_testAsyncThrowInAsync.bind(this));
}

CHUtil.inherits(Device, CHDevice);

Device.prototype._getDeviceRootSchema = function() {
  return JSON.parse(fs.readFileSync(__dirname + '/schema.json').toString());
};

module.exports = Device;