function echo(args, callback) {
  return callback(null, {
    output: args.input
  });
}

module.exports = echo;
