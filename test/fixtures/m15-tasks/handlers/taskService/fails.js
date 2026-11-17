// A module's own failure (a coded Error keeps its words: lib/countinghouse-error.js
// fromModule), its text longer than declared text's bound and carrying a
// control character and a bidi override: what a task's error says of it is
// cut and cleaned, its code kept (the review of the M15 plan). input.code: the
// module's code (M15_FAILED unless given).
module.exports = async (input) => {
  const err = new Error(`it failed\u0007 here‮ and there${' and on'.repeat(100)}`);
  err.code = typeof(input.code) === 'string' ? input.code : 'M15_FAILED';
  throw err;
};
