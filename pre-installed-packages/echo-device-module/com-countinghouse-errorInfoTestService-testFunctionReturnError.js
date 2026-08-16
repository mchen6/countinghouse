function testFunctionReturnError(args, callback) {
  return callback(null, (err, data) => {
    console.log(data);
  });
}

module.exports = testFunctionReturnError;