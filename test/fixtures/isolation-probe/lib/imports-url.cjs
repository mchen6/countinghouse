// A CommonJS file's own import() of a file: URL: taken as a require (Node
// up to 24.15 gives a real require that shape, lib/fs-broker/identity.js
// isRequire), and it resolves alike either way, one file with no exports
// map applying to it
module.exports = () => import(require('url').pathToFileURL(require('path').join(__dirname, 'own.cjs')).href).then((m) => m.default.own);
