function com_countinghouse_echoService_echoWithAPICache(args, callback) {
  return callback(null, {
    output: args.input
  });
}

module.exports = com_countinghouse_echoService_echoWithAPICache;