function com_apemesh_echoService_echoWithAPICache(args, callback) {
  return callback(null, {
    output: args.input
  });
}

module.exports = com_apemesh_echoService_echoWithAPICache;