function echo(args, callback) {
  CdifUtil.deviceLog(this, 'aaabbbccc');
  return callback(null, {
    output: args.input
  });
}

module.exports = echo;
