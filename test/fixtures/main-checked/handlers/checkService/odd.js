// odd.js -- values structured clone carries and JSON does not (test/sandbox/42):
// input.kind 'function' answers with a function inside, which cannot cross.
module.exports = async (input) => {
  if (input.kind === 'function') return {output: {f: () => 1}};
  // how many replies forge.js replaced with its hand-made bytes (test/sandbox/42)
  const forged = (globalThis.__mainCheckedForge != null) ? globalThis.__mainCheckedForge.replaced : 0;
  return {output: {d: new Date(5), m: new Map([[1, 'a']]), s: new Set([2]), t: new Uint8Array([1, 2]), b: 10n, u: [undefined], forged: forged}};
};
