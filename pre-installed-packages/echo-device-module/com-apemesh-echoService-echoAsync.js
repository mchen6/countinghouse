function timeout(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function com_apemesh_echoService_echoAsync(args) {
  await timeout(1000);
  return {output: args.input};
}

module.exports = com_apemesh_echoService_echoAsync;