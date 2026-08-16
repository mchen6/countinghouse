function com_countinghouse_errorInfoTestService_testThrowError(args, callback) {
  const t = null.toString();
  return callback(null, {
    output: {result: t}
  });
}

module.exports = com_countinghouse_errorInfoTestService_testThrowError;