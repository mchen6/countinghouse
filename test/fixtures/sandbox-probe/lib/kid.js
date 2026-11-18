// a file the probe requires, to see Node's linkage kept (#406): its parent
// as its own top-level code sees it, which must be the requiring Module
// (never a shadow of the wrapper's)
module.exports = {kid: true, parentAtLoad: module.parent};
