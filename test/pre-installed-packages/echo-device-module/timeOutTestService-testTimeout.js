function testTimeout(args, callback) {
  setTimeout(() => {
    return callback(null, {
      output: {}
    });
  }, 40000);
}

module.exports = testTimeout;