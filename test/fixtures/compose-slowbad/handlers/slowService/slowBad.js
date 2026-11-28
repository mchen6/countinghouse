// Answers after 4 s, past composition 25's 2 s hop timeout, with an output its
// schema refuses: the main thread's validator would refuse it, after its
// caller has moved on.
module.exports = async () => {
  await new Promise((resolve) => setTimeout(resolve, 4000));
  return {output: {n: 'not a number'}};
};
