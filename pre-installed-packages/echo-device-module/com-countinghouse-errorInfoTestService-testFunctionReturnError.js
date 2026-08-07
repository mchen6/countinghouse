function testFunctionReturnError(args, callback) {
  return callback(null, function(err, data) {
    console.log(data);
  });
}

module.exports = testFunctionReturnError;