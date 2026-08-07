function com_mcpforge_errorInfoTestService_testAsyncThrowInDomain(args, callback) {
  setTimeout(() => {
    var t = null.toString();
    return callback(null, {
      output: {}
    });
  }, 1000);
}

module.exports = com_mcpforge_errorInfoTestService_testAsyncThrowInDomain;