// die.js -- blocks the worker for 600 ms and then ends it without answering:
// a message sent meanwhile (an unload) is never handled, never acknowledged.
module.exports = () => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600);
  process.exit(3);
};
