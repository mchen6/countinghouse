function com_apemesh_errorInfoTestService_testThrowError(args, callback) {
  var t = null.toString();
  return callback(null, {
    output: {result: t}
  });
}

module.exports = com_apemesh_errorInfoTestService_testThrowError;