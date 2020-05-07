function API名称(args, callback) {
    this.client.invoke({actionName: 'echo', input:{foo: [{item1: 'dsf', item2: false, item3: 1233}], bar: 'test', baz: 12334}}, function(err, data) {
      return callback(null, data);
    });
}

module.exports = API名称;