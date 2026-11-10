// Return ctx.error to fail a call with the module's own code (logger-design
// §5.1). Throwing it or passing it to a callback gives the same answer.
module.exports = async (input, ctx) => {
  if (input == null || typeof(input.text) !== 'string') {
    return ctx.error('INPUT_REJECTED', 'text must be a string');
  }
  return {output: {text: input.text.toUpperCase()}};
};
