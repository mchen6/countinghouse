// busy.js -- blocks the worker's thread for 600 ms, then answers. A message
// the main thread sends meanwhile (an unload, say) is handled only after this
// reply has been posted.
module.exports = async () => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600);
  return {output: {ok: true}};
};
