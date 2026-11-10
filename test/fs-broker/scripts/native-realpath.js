// FB3: the module-facing fs.realpathSync under a resolve grant (the loader's
// L1 route to the original fs) answers what the kernel opens.
const path = require('path');

module.exports = async (fs, root, ctx) => {
  const grant = ctx.handled.grant;
  const y = path.join(ctx.extra.dir, 'y');
  const out = {};
  const release = grant.resolving([ctx.extra.dir]);
  try {
    out.realpathSync = fs.realpathSync(y);
    out.realpathSyncNative = fs.realpathSync.native(y);
  } finally { release(); }
  return out;
};
