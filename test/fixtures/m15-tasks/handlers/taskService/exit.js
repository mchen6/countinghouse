// m15-tasks fixture: answers, then ends its worker 50 ms later -- a crash,
// as the module supervisor counts one (mcp-contract 27 suspends the module
// with three)
module.exports = async () => {
  setTimeout(() => process.exit(1), 50);
  return {output: {exiting: true}};
};
