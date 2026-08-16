module.exports = (input, ctx, callback) => {
  const t = null.toString();
  return callback(null, {
    output: {result: t}
  });
}
