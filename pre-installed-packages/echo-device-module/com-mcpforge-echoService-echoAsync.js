function timeout(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function com_mcpforge_echoService_echoAsync(args) {
  await timeout(1000);
  return {output: args.input};
}

module.exports = com_mcpforge_echoService_echoAsync;