// exit.js -- ends the worker, as a crash would.
module.exports = async () => {
  setTimeout(() => process.exit(1), 10);
  return {output: {ok: true, code: null}};
};
