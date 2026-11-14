// big.js -- an output of input.n characters, after input.wait ms when given
// (test/sandbox/41, 42).
module.exports = async (input) => {
  if (Number.isInteger(input.wait)) await new Promise((r) => setTimeout(r, input.wait));
  return {output: {s: 'x'.repeat(input.n)}};
};
