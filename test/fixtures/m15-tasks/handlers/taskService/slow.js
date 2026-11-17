module.exports = async (input) => {
  await new Promise((resolve) => setTimeout(resolve, Number(input.ms) || 0));
  return {output: {done: true}};
};
