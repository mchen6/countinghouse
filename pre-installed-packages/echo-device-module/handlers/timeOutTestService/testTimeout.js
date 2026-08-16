module.exports = (input, ctx, callback) => {
  setTimeout(() => {
    return callback(null, {
      output: {}
    });
  }, 40000);
}
