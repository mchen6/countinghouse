module.exports = (input, ctx, callback) => {
  setTimeout(() => {
    const t = null.toString();
    return callback(null, {
      output: {}
    });
  }, 1000);
}
