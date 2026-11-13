// How usage output names a server whose calls went to an acceptance stand-in
// (--remoteOriginMap): one label, so the receipt, the usage report and its
// aggregate say it the same way.
const STAND_IN = 'acceptance stand-in';

// -> the server's name, marked when its calls went to a stand-in.
function serverLabel(server, mapped) {
  return mapped === true ? `${server} (${STAND_IN})` : server;
}

module.exports = {STAND_IN, serverLabel};
