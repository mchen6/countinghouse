module.exports = async (input, ctx) => {
  if (input.foo === '111') return {output: {result: true}};

  if (input.foo === '222') throw new Error('error', {fault: {reason: 'err', info :input.foo}});
  if (input.foo === '333') throw new Error('error', input.foo);
  throw new Error('unknown error');
}
