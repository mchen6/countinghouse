function com_mcpforge_echoService_echoWithAPICache(args, callback) {
  return callback(null, {
    output: args.input
  });
}

module.exports = com_mcpforge_echoService_echoWithAPICache;