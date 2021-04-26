function testStringTypeReturnError(args, callback) {
  return callback(null, '123');
}

module.exports = testStringTypeReturnError;