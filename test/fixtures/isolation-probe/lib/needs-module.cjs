// a CommonJS file reached by import() that asks for the module built-in
module.exports = {createRequire: typeof(require('module').createRequire)};
