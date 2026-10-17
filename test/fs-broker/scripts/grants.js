// Uses the grant controller the way identity.js does, from inside the worker.
const path = require('path');

module.exports = async (fs, root, ctx) => {
  const grant = ctx.handled.grant;
  const dir = ctx.extra.dir;
  const file = path.join(dir, 'f.txt');
  const out = {};
  const attempt = (fn) => { try { fn(); return 'read'; } catch (e) { return e.code; } };
  out.before = attempt(() => fs.realpathSync(file));   // no grant: the broker answers
  let release = grant.resolving([dir]);
  out.realpathGranted = fs.realpathSync(file) === file;
  out.dotdotNotGranted = attempt(() => fs.statSync(`${dir}/../${path.basename(dir)}-x`));
  out.readNotGranted = attempt(() => fs.readFileSync(file, 'utf8'));
  release();
  release = grant.reading(file);
  out.readGranted = fs.readFileSync(file, 'utf8');
  out.otherNotGranted = attempt(() => fs.readFileSync(path.join(dir, 'g.txt'), 'utf8'));
  release();
  out.originalsRead = grant.originals.readFileSync(file, 'utf8');
  release = grant.boot([dir]);
  out.bootRead = fs.readFileSync(path.join(dir, 'g.txt'), 'utf8');
  release();
  out.afterBoot = attempt(() => fs.readFileSync(path.join(dir, 'g.txt'), 'utf8'));
  out.grantNotExported = Object.keys(ctx.patch).includes('grant') === false;
  return out;
};
