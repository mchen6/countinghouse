// busy.js -- says it has started (/data/started, in its data directory),
// then holds its worker until the test releases it (/data/release appears)
// and answers. A message the main thread sends meanwhile (an unload, say) is
// handled only after this reply has been posted. A gate, not a fixed time,
// so the test orders every step by an event, never by a sleep (#221). Held
// at most input.maxMs (default 20 s), so a failed test never leaves it
// running.
const fs = require('fs');

module.exports = async (input) => {
  const maxMs = (input && input.maxMs) || 20000;
  fs.writeFileSync('/data/started', String(Date.now()));
  const gate = new Int32Array(new SharedArrayBuffer(4));
  for (let waited = 0; !fs.existsSync('/data/release') && waited < maxMs; waited += 50) Atomics.wait(gate, 0, 0, 50);
  return {output: {ok: true}};
};
