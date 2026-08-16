module.exports = (input, ctx, callback) => {
  return callback(null, (err, data) => {
    console.log(data);
  });
}
