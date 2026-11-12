// The single-identity profile's start checks (local-mode spec §4; the
// reviewer, 2026-11-11). A direct peer hop carries no usage call id (the
// callee is given {input} only), so in the profile its server calls would go
// unrecorded and a scenario's receipt would say less was read than was.
// There, peer channels are off: an explicit --directPeerChannels is refused
// (exit 2), and without it the 7.1.0 default is turned off before any worker
// gets its options. Hosting keeps peer channels, and its receipts are a known
// undercount for hops that take them (docs/cli-and-api-reference.md). Carrying
// the id over a peer hop needs the broker to grant the callee's worker: the
// step to take when someone needs peer channels with receipts.
//
// profileStart(options) -> null, or the refusal message framework.js prints
// before exiting 2.
function profileStart(options) {
  if (options == null || options.singleIdentity !== true) return null;
  if (options.directPeerChannelsGiven === true) return '--directPeerChannels and the single-identity profile: choose one';
  options.directPeerChannels = false;
  return null;
}

module.exports = {profileStart};
