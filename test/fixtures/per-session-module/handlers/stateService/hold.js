// per-session-module fixture: a call held in flight for input.ms
module.exports = async (input) => {
  const ms = Number(input && input.ms) || 0;
  await new Promise((resolve) => setTimeout(resolve, ms));
  return {output: {held: ms}};
};
