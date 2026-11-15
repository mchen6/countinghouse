// Lean worker step 3 (test/sandbox/48; #177's re-review, item 2): before any CHUtil helper
// has run, module code reaches countinghouse-util through chutil-facade's own module object
// in require.cache, attaches it itself, and tries a request through it. Its own module (its
// own worker), so the other probes' worker is not left attached this way.
module.exports = async (input) => {
  const out = {};
  try {
    const key = Object.keys(require.cache).find((k) => /[\\/]lib[\\/]chutil-facade\.js$/.test(k));
    out.facadeInCache = key != null;
    if (key == null) return {output: out};
    const util = require.cache[key].require('./countinghouse-util');
    let handed;
    try { handed = util.__attach({dm: null, ci: null, redis: null, outbound: null}); out.attached = true; } catch (e) { out.attached = String(e.message).slice(0, 200); }
    out.handed = typeof(handed);
    out.request = await new Promise((resolve) => {
      try {
        util.request({url: input.url, timeout: 3000}, (err) => resolve((err != null) ? {outcome: 'error', code: (err.code != null) ? String(err.code) : null} : {outcome: 'sent'}));
      } catch (e) { resolve({outcome: 'threw', code: (e.code != null) ? String(e.code) : null}); }
    });
  } catch (e) {
    out.error = String(e && e.message).slice(0, 300);
  }
  return {output: out};
};
