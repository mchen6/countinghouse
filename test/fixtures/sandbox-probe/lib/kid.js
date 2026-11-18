// a file the probe requires (#406): its parent as its own top-level code
// sees it, which under the sandbox is a data-only stand-in named for the
// requiring file (never the requiring Module, never the wrapper's shadow)
module.exports = {kid: true, parentAtLoad: module.parent, mainAtLoad: !module.parent};
