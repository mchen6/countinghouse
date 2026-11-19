// A CommonJS file's own import() of an ES module by a relative name: an
// import, never taken as a require (the review of e0f39de9)
module.exports = () => import('./own.mjs').then((m) => m.own);
