// external.js -- holds Buffers outside the JS heap, past externalMb; the main
// thread's poll terminates the worker within about a second.
module.exports = async () => {
  globalThis.__hogKeep = [];
  for (let i = 0; i < 16; i++) globalThis.__hogKeep.push(Buffer.alloc(8 * 1024 * 1024, 1));
  return {output: {ok: true}};
};
