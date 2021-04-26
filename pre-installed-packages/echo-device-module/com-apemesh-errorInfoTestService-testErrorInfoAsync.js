async function com_apemesh_errorInfoTestService_testErrorInfoAsync(args) {
  if (args.input.foo === '111') return {output: {result: true}};

  if (args.input.foo === '222') throw new Error('error', {fault: {reason: 'err', info :args.input.foo}});
  if (args.input.foo === '333') throw new Error('error', args.input.foo);
  throw new Error('unknown error');
}

module.exports = com_apemesh_errorInfoTestService_testErrorInfoAsync;