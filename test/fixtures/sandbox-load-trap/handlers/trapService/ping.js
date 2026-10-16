// ping.js -- runs at load: LOAD_TRAP=exit ends the worker, LOAD_TRAP=block
// never yields its event loop.
if (process.env.LOAD_TRAP === 'exit') process.exit(3);
if (process.env.LOAD_TRAP === 'block') for (;;) { /* spin */ }
module.exports = async () => ({output: {ok: true}});
