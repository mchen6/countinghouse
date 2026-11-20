// input.n empty lines to stdout: each costs one byte to write here, and the
// operator's log a whole line (the review of #190).
module.exports = async (input) => {
  process.stdout.write('\n'.repeat(input.n));
  return {output: {ok: true}};
};
