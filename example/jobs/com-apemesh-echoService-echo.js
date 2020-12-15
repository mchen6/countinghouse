function echo(args, callback) {

  var k = 0;
  for (var i =0; i< 1000000000; i++) {
    k += i;
//    console.log(k);
//    if (k == 123998265028) process.exit(-1);
  }
  console.log(k);

  return callback(null, {
    output: {result: k}
  });
}

module.exports = echo;
