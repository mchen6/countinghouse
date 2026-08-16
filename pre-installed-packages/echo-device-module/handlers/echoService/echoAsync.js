function timeout(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = async (input, ctx) => {
  await timeout(1000);
  return {output: input};
}
