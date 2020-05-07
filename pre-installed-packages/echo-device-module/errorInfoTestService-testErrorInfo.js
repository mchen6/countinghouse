function testErrorInfo(args, callback) {
  if (args.input.foo === '111') return callback(null, {output: {result: true}});
  
  if (args.input.foo === '222') return callback(new Error('error'), {fault: {reason: 'err', info :args.input.foo}});
  if (args.input.foo === '333') return callback(new Error('error'), args.input.foo);
  return callback(new Error('unknown error'));
}

module.exports = testErrorInfo;