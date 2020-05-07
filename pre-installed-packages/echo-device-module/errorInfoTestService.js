var testBooleanTypeReturnError = CdifUtil.loadFile(__dirname + '/errorInfoTestService-testBooleanTypeReturnError.js');
var testStringTypeReturnError = CdifUtil.loadFile(__dirname + '/errorInfoTestService-testStringTypeReturnError.js');
var testNumberTypeReturnError = CdifUtil.loadFile(__dirname + '/errorInfoTestService-testNumberTypeReturnError.js');
var testNullReturnError = CdifUtil.loadFile(__dirname + '/errorInfoTestService-testNullReturnError.js');
var testFunctionReturnError = CdifUtil.loadFile(__dirname + '/errorInfoTestService-testFunctionReturnError.js');
var testErrorInfo = CdifUtil.loadFile(__dirname + '/errorInfoTestService-testErrorInfo.js');

module.exports = {
  testErrorInfo: testErrorInfo,
  testFunctionReturnError: testFunctionReturnError,
  testNullReturnError: testNullReturnError,
  testNumberTypeReturnError: testNumberTypeReturnError,
  testStringTypeReturnError: testStringTypeReturnError,
  testBooleanTypeReturnError: testBooleanTypeReturnError
};