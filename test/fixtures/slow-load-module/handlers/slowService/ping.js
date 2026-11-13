// Loading this file takes about 3 s (in the module's own worker): a module
// that is still loading when a client first lists the tools (test/stdio/04).
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
module.exports = async () => ({output: {text: 'pong'}});
