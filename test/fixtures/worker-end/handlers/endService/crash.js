// crash.js -- ends the worker 100 ms later without answering this call.
module.exports = () => {
  setTimeout(() => process.exit(3), 100);
  return new Promise(() => {});
};
