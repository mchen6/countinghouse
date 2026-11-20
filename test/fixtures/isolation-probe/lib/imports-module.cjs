// A CommonJS file's own import of the module built-in (#434's floor-Node
// fix): under enforce the reduced module's CommonJS form, its names still
// reached as named exports
module.exports = () => import('module').then((m) => `${typeof(m.createRequire)} ${typeof(m.default.createRequire)}`);
