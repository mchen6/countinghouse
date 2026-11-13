// CHUtil's HTTP helper, on first use (test/sandbox/40 and 09): whether its
// library is in this worker yet, and one call through it.
const loaded = () => ({
  request: Object.keys(require.cache).some((k) => /[\\/]node_modules[\\/]postman-request[\\/]/.test(k))
});
const failed = (err) => ({outcome: 'error', code: err.code != null ? String(err.code) : null, message: String(err.message).slice(0, 300)});

module.exports = (input) => new Promise((resolve) => {
  if (input.what === 'loaded') return resolve({output: {loaded: loaded()}});
  return CHUtil.request({url: input.url, timeout: 5000}, (err, res, body) => resolve({output: Object.assign(
    err != null ? failed(err) : {outcome: 'ok', status: res.statusCode, body: String(body)}, {loaded: loaded()})}));
});
