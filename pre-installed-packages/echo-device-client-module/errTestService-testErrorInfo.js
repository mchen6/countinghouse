function testErrorInfo(args, callback) {
  this.errorInfoTestclient.invoke({actionName: 'testErrorInfo', input: args.input}, function(err, data) {
    if (err) return callback(err, data);
    return callback(null, {output: data});
  });
}

module.exports = testErrorInfo;