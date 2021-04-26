function testNullReturnError(args, callback) {
  return callback(null, null);
}

module.exports = testNullReturnError;