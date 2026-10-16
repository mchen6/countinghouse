// heap.js -- grows the JS heap until V8 stops the worker (heapMb).
module.exports = async () => {
  const keep = [];
  for (;;) keep.push(new Array(1e6).fill(1));
};
