function timeout(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function com_countinghouse_timeOutTestService_testTimeoutAsync(args) {
  await timeout(40000);
  return {output: {}};
}

module.exports = com_countinghouse_timeOutTestService_testTimeoutAsync;