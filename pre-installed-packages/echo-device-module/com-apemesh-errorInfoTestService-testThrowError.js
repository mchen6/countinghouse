function com_apemesh_errorInfoTestService_testThrowError(args, callback) {
  setTimeout( () => {
    var t = null.toString();
    return callback(null, {
      output: {result: t}
    });
  }, 1000);
}

module.exports = com_apemesh_errorInfoTestService_testThrowError;