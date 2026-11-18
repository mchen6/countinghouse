// a decoy of countinghouse's lib/bind-address.js: what a poisoned
// relative-resolve cache would hand the runtime (#406's second review)
module.exports = {hostIp: () => 'POISONED'};
