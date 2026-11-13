// CHUtil's HTTP and SOAP helpers, on first use (test/sandbox/40): whether
// their libraries are in this worker yet, and one call through each.
const loaded = () => {
  const keys = Object.keys(require.cache);
  return {
    request: keys.some((k) => /[\\/]node_modules[\\/]postman-request[\\/]/.test(k)),
    soap:    keys.some((k) => /[\\/]node_modules[\\/]soap[\\/]/.test(k))
  };
};
const failed = (err) => ({outcome: 'error', code: err.code != null ? String(err.code) : null, message: String(err.message).slice(0, 300)});

module.exports = {
  netService: {
    probe: (input, ctx, callback) => {
      if (input.what === 'loaded') return callback(null, {output: {loaded: loaded()}});
      if (input.what === 'request') {
        return CHUtil.request({url: input.url, timeout: 5000}, (err, res, body) => callback(null, {output: Object.assign(
          err != null ? failed(err) : {outcome: 'ok', status: res.statusCode, body: String(body)}, {loaded: loaded()})}));
      }
      return CHUtil.createSOAPClient(input.url, {}, (err, client) => callback(null, {output: Object.assign(
        err != null ? failed(err) : {outcome: 'ok', services: Object.keys(client.describe())}, {loaded: loaded()})}));
    }
  }
};
