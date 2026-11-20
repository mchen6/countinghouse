'use strict';
// How many versions of a module's settings a worker keeps (lib/handler-ctx.js),
// and so how many the main thread counts as its (lib/settings-gate.js): one
// constant both sides take, so the two rings never disagree.
module.exports = Object.freeze({KEPT: 4});
