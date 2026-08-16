module.exports = (input, ctx, callback) => {
  if (input.foo === '111') return callback(null, {output: {result: true}});
  
  if (input.foo === '222') return callback(new Error('error'), {fault: {reason: 'err', info :input.foo}});
  if (input.foo === '333') return callback(new Error('error'), input.foo);
  return callback(new Error('unknown error'));
}
