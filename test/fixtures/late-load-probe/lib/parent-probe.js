// parent-probe.js -- loaded by CHUtil.loadFile (test/sandbox/66): reports
// the parent the runtime's load gave it. The CLI idiom must not fire here
// either (#425's review).
if (!module.parent) throw new Error('parent-probe: loaded as a main module');
module.exports = {parent: module.parent};
