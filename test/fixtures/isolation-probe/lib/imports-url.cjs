// A CommonJS file's own import() of a file: URL: an import, never taken as
// a require (the medium review of #434's round 4)
module.exports = () => import(require('url').pathToFileURL(require('path').join(__dirname, 'own.cjs')).href).then((m) => m.default.own);
