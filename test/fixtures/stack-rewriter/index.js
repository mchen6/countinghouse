// index.js -- a module that rewrites every stack trace (as source-map-support
// and some loggers do), then loads its handler through CHUtil.loadFile with a
// path built from __dirname. Single-thread mode must still find the caller.
Error.prepareStackTrace = () => 'rewritten';
const where = CHUtil.loadFile(`${__dirname}/lib/where.js`);
module.exports = {probeService: {where: where}};
