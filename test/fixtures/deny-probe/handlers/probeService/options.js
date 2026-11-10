// options.js -- what the worker's cli-options holds, through require.cache
// (module code shares the worker's realm): never the values, only whether
// redisUrl and dbUrl are there.
module.exports = async () => {
  const key = Object.keys(require.cache).find((f) => /[\\/]cli-options\.js$/.test(f));
  const o = key != null ? require.cache[key].exports : null;
  return {output: {found: o != null, hasRedisUrl: o != null && o.redisUrl != null, hasDbUrl: o != null && o.dbUrl != null}};
};
