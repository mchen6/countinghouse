var fs = require('fs');
var com_mcpforge_echoService_echo = McpForgeUtil.loadFile(__dirname + '/com-mcpforge-echoService.js').com_mcpforge_echoService_echo;
var com_mcpforge_echoService_echoWithAPICache = McpForgeUtil.loadFile(__dirname + '/com-mcpforge-echoService.js').com_mcpforge_echoService_echoWithAPICache;
var com_mcpforge_echoService_echoAsync = McpForgeUtil.loadFile(__dirname + '/com-mcpforge-echoService.js').com_mcpforge_echoService_echoAsync;
var com_mcpforge_timeOutTestService_testTimeout = McpForgeUtil.loadFile(__dirname + '/com-mcpforge-timeOutTestService.js').com_mcpforge_timeOutTestService_testTimeout;
var com_mcpforge_timeOutTestService_testTimeoutAsync = McpForgeUtil.loadFile(__dirname + '/com-mcpforge-timeOutTestService.js').com_mcpforge_timeOutTestService_testTimeoutAsync;
var com_mcpforge_errorInfoTestService_testErrorInfo = McpForgeUtil.loadFile(__dirname + '/com-mcpforge-errorInfoTestService.js').com_mcpforge_errorInfoTestService_testErrorInfo;
var com_mcpforge_errorInfoTestService_testFunctionReturnError = McpForgeUtil.loadFile(__dirname + '/com-mcpforge-errorInfoTestService.js').com_mcpforge_errorInfoTestService_testFunctionReturnError;
var com_mcpforge_errorInfoTestService_testNullReturnError = McpForgeUtil.loadFile(__dirname + '/com-mcpforge-errorInfoTestService.js').com_mcpforge_errorInfoTestService_testNullReturnError;
var com_mcpforge_errorInfoTestService_testNumberTypeReturnError = McpForgeUtil.loadFile(__dirname + '/com-mcpforge-errorInfoTestService.js').com_mcpforge_errorInfoTestService_testNumberTypeReturnError;
var com_mcpforge_errorInfoTestService_testStringTypeReturnError = McpForgeUtil.loadFile(__dirname + '/com-mcpforge-errorInfoTestService.js').com_mcpforge_errorInfoTestService_testStringTypeReturnError;
var com_mcpforge_errorInfoTestService_testBooleanTypeReturnError = McpForgeUtil.loadFile(__dirname + '/com-mcpforge-errorInfoTestService.js').com_mcpforge_errorInfoTestService_testBooleanTypeReturnError;
var com_mcpforge_errorInfoTestService_testErrorInfoAsync = McpForgeUtil.loadFile(__dirname + '/com-mcpforge-errorInfoTestService.js').com_mcpforge_errorInfoTestService_testErrorInfoAsync;
var com_mcpforge_errorInfoTestService_testThrowError = McpForgeUtil.loadFile(__dirname + '/com-mcpforge-errorInfoTestService.js').com_mcpforge_errorInfoTestService_testThrowError;
var com_mcpforge_errorInfoTestService_testThrowErrorAsync = McpForgeUtil.loadFile(__dirname + '/com-mcpforge-errorInfoTestService.js').com_mcpforge_errorInfoTestService_testThrowErrorAsync;
var com_mcpforge_errorInfoTestService_testAsyncThrowInDomain = McpForgeUtil.loadFile(__dirname + '/com-mcpforge-errorInfoTestService.js').com_mcpforge_errorInfoTestService_testAsyncThrowInDomain;
var com_mcpforge_errorInfoTestService_testAsyncThrowInAsync = McpForgeUtil.loadFile(__dirname + '/com-mcpforge-errorInfoTestService.js').com_mcpforge_errorInfoTestService_testAsyncThrowInAsync;

function Device() {
  var spec = JSON.parse(fs.readFileSync(__dirname + '/api.json').toString());
  McpForgeDevice.call(this, spec);
  this.setAction('urn:mcpforge-com:serviceID:echoService', 'echo', com_mcpforge_echoService_echo.bind(this));
  this.setAction('urn:mcpforge-com:serviceID:echoService', 'echoWithAPICache', com_mcpforge_echoService_echoWithAPICache.bind(this));
  this.setAction('urn:mcpforge-com:serviceID:echoService', 'echoAsync', com_mcpforge_echoService_echoAsync.bind(this));
  this.setAction('urn:mcpforge-com:serviceID:timeOutTestService', 'testTimeout', com_mcpforge_timeOutTestService_testTimeout.bind(this));
  this.setAction('urn:mcpforge-com:serviceID:timeOutTestService', 'testTimeoutAsync', com_mcpforge_timeOutTestService_testTimeoutAsync.bind(this));
  this.setAction('urn:mcpforge-com:serviceID:errorInfoTestService', 'testErrorInfo', com_mcpforge_errorInfoTestService_testErrorInfo.bind(this));
  this.setAction('urn:mcpforge-com:serviceID:errorInfoTestService', 'testFunctionReturnError', com_mcpforge_errorInfoTestService_testFunctionReturnError.bind(this));
  this.setAction('urn:mcpforge-com:serviceID:errorInfoTestService', 'testNullReturnError', com_mcpforge_errorInfoTestService_testNullReturnError.bind(this));
  this.setAction('urn:mcpforge-com:serviceID:errorInfoTestService', 'testNumberTypeReturnError', com_mcpforge_errorInfoTestService_testNumberTypeReturnError.bind(this));
  this.setAction('urn:mcpforge-com:serviceID:errorInfoTestService', 'testStringTypeReturnError', com_mcpforge_errorInfoTestService_testStringTypeReturnError.bind(this));
  this.setAction('urn:mcpforge-com:serviceID:errorInfoTestService', 'testBooleanTypeReturnError', com_mcpforge_errorInfoTestService_testBooleanTypeReturnError.bind(this));
  this.setAction('urn:mcpforge-com:serviceID:errorInfoTestService', 'testErrorInfoAsync', com_mcpforge_errorInfoTestService_testErrorInfoAsync.bind(this));
  this.setAction('urn:mcpforge-com:serviceID:errorInfoTestService', 'testThrowError', com_mcpforge_errorInfoTestService_testThrowError.bind(this));
  this.setAction('urn:mcpforge-com:serviceID:errorInfoTestService', 'testThrowErrorAsync', com_mcpforge_errorInfoTestService_testThrowErrorAsync.bind(this));
  this.setAction('urn:mcpforge-com:serviceID:errorInfoTestService', 'testAsyncThrowInDomain', com_mcpforge_errorInfoTestService_testAsyncThrowInDomain.bind(this));
  this.setAction('urn:mcpforge-com:serviceID:errorInfoTestService', 'testAsyncThrowInAsync', com_mcpforge_errorInfoTestService_testAsyncThrowInAsync.bind(this));
}

McpForgeUtil.inherits(Device, McpForgeDevice);

Device.prototype._getDeviceRootSchema = function() {
  return JSON.parse(fs.readFileSync(__dirname + '/schema.json').toString());
};

module.exports = Device;