// Answers after input.ms milliseconds (test/sandbox/54: a call held to its
// own timeout, and a hop to its caller's).
module.exports = (input) => new Promise((resolve) => setTimeout(() => resolve({output: {waited: input.ms}}), input.ms));
