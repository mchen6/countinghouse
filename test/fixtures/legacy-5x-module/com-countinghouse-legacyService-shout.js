function shout(args, callback) {
  var input = args.input;
  if (input == null || typeof(input.text) !== 'string') {
    return callback(Object.assign(new Error('text must be a string'), {code: 'INPUT_REJECTED'}), null);
  }
  return callback(null, {output: {text: input.text.toUpperCase()}});
}

module.exports = shout;
