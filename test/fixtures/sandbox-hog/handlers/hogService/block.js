// block.js -- blocks the event loop for good; the heartbeat (maxBlockMs)
// terminates the worker.
module.exports = async () => {
  for (;;) { /* spin */ }
};
