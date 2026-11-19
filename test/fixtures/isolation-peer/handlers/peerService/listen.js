// listen.js -- one message on the isolation-68 channel, or why none came
// (test/sandbox/68's BroadcastChannel case: a module worker of its own)
module.exports = async () => {
  if (typeof(globalThis.BroadcastChannel) !== 'function') return {output: {detail: 'no BroadcastChannel'}};
  const c = new globalThis.BroadcastChannel('isolation-68');
  const detail = await new Promise((resolve) => {
    const t = setTimeout(() => resolve('nothing received'), 3000);
    c.onmessage = (e) => { clearTimeout(t); resolve(`received ${e.data}`); };
  });
  c.close();
  return {output: {detail}};
};
