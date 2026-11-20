// A module that rewrites every stack trace (as source-map-support and some
// loggers do), then loads its handler through CHUtil.loadFile with a path
// built from __dirname. Single-thread mode must still find the caller. In a
// handler file: a main entry is never run (lib/module-layout.js).
Error.prepareStackTrace = () => 'rewritten';
module.exports = CHUtil.loadFile(`${__dirname}/../../lib/where.js`);
