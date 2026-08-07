function testNumberTypeReturnError(args, callback) {
  return callback(null, 123);
}

module.exports = testNumberTypeReturnError;