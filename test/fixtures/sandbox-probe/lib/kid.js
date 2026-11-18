// a file the probe requires (#406): its parent as its own top-level code
// sees it, which under the sandbox is none (never a shadow of the wrapper's)
module.exports = {kid: true, parentAtLoad: module.parent};
