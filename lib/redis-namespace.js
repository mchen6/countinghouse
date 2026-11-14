// ctx.redis is per module (#164): every module shares the store's key space
// (Redis db 5, or the local store's kv), so the main thread puts every key
// argument of every command a module sends under m:<module name>:, the name
// main loaded the module under (lib/module-manager.js hostModuleName), never
// one the worker states. Runtime-internal keys (jobinfo:* and the like) carry
// no such prefix, so a module cannot name them.
//
// The key positions are a table over every allowed command
// (lib/redis-api.js ALLOWED_COMMANDS): 'first' (the first argument is the one
// key) or 'all' (every argument is a key). A command whose keys cannot be
// found statically (a pattern, a script's dynamic keys) is refused, and none
// is on the allowed list; neither is a command missing from this table, nor
// multi and exec (under --store redis node_redis's multi runs any command name
// queued in it). None of the allowed commands answers with key names, so only
// an error's text can carry one, and it loses the prefix (unprefixError).
const KEY_POSITIONS = Object.freeze({
  get: 'first', set: 'first', pexpire: 'first',
  hget: 'first', hset: 'first', hdel: 'first', hmget: 'first', hmset: 'first', hgetall: 'first',
  lpush: 'first', rpush: 'first', lrange: 'first', llen: 'first', ltrim: 'first',
  zadd: 'first', zrange: 'first', zrem: 'first',
  del: 'all', mget: 'all'
});

const isKey = (k) => typeof(k) === 'string' || (typeof(k) === 'number' && Number.isFinite(k));

// The module's prefix, or null for a name that is not one. The name is
// URI-encoded, so it holds no ':' and no prefix is the start of another's:
// a module named victim:x is m:victim%3Ax:, never inside m:victim:.
// A name encodeURIComponent cannot encode (a lone surrogate) gives none too;
// module-data.js safeName refuses such a name at load.
function prefixFor(moduleName) {
  if (typeof(moduleName) !== 'string' || moduleName === '') return null;
  try { return `m:${encodeURIComponent(moduleName)}:`; } catch (e) { return null; }
}

// node_redis takes a command's arguments spread or as one array; a trailing
// undefined (an absent callback) is not an argument.
const spread = (data) => {
  const args = (Array.isArray(data) && data.length === 1 && Array.isArray(data[0])) ? data[0] : data;
  let end = args.length;
  while (end > 0 && args[end - 1] === undefined) end -= 1;
  return end === args.length ? args : args.slice(0, end);
};

function keyed(op, args, prefix) {
  const where = Object.prototype.hasOwnProperty.call(KEY_POSITIONS, op) ? KEY_POSITIONS[op] : null;
  if (where === 'first') {
    if (args.length === 0 || !isKey(args[0])) return {refused: `${op} needs a key, a string or a number`};
    // hmset(key, {field: value}): the fields as pairs, which every client takes
    const rest = (op === 'hmset' && args.length === 2 && args[1] != null && typeof(args[1]) === 'object' && !Array.isArray(args[1]))
      ? Object.entries(args[1]).flat() : args.slice(1);
    return {args: [prefix + String(args[0]), ...rest]};
  }
  if (where === 'all') {
    if (args.length === 0 || !args.every(isKey)) return {refused: `${op} needs keys, each a string or a number`};
    return {args: args.map((k) => prefix + String(k))};
  }
  return {refused: `${String(op).slice(0, 64)} is not available to a module (its keys cannot be put in the module's namespace)`};
}

// (op, the arguments the module sent, prefix) -> {args} or {refused: why}.
function namespaceCommand(op, data, prefix) {
  if (prefix == null) return {refused: 'no namespace for this module'};
  if (!Array.isArray(data)) return {refused: 'the arguments must be a list'};
  return keyed(op, spread(data), prefix);
}

// An error's text without the module's prefix.
function unprefixError(message, prefix) {
  return (typeof(message) === 'string' && prefix != null) ? message.split(prefix).join('') : message;
}

// One module's command, run on the main thread's client in the module's
// namespace: the worker's (lib/device-manager.js) and single-thread mode's
// (lib/redis-api.js namespacedClient). callback(err, result).
function runNamespaced(client, prefix, op, data, callback) {
  const r = namespaceCommand(op, data, prefix);
  if (r.refused != null) return process.nextTick(callback, new Error(r.refused));
  if (client == null) return process.nextTick(callback, new Error('Redis is not available here'));
  return client[op](r.args, (e, result) => (e ? callback(new Error(unprefixError(e.message, prefix))) : callback(null, result)));
}

// A Redis glob that matches the prefix itself, then anything.
const globOf = (prefix) => `${prefix.replace(/[*?[\]\\]/g, '\\$&')}*`;
const SCAN_COUNT = 500;
const PURGE_TIMEOUT_MS = 30000;

// Every key in a module's namespace, deleted: for an uninstalled module, so a
// later module of the same name inherits none of its keys. The local store
// deletes by prefix; Redis is scanned (SCAN MATCH, a page at a time) and each
// page's keys unlinked (UNLINK frees large values in the background; DEL
// where the client has no unlink). A store that does not answer within
// timeoutMs fails it (node_redis queues commands while Redis is away). The
// main thread's alone. -> Promise of how many.
async function purgeNamespace(kv, prefix, {timeoutMs = PURGE_TIMEOUT_MS} = {}) {
  if (prefix == null) throw new Error('no namespace to purge');
  if (typeof(kv.deletePrefix) === 'function') return kv.deletePrefix(prefix);
  let timer = null;
  const late = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`the store did not answer within ${timeoutMs / 1000} s`)), timeoutMs);
  });
  const call = (fn, ...args) => Promise.race([late, new Promise((resolve, reject) => fn.call(kv, ...args, (e, r) => (e ? reject(e) : resolve(r))))]);
  const remove = typeof(kv.unlink) === 'function' ? kv.unlink : kv.del;
  try {
    let cursor = '0';
    let deleted = 0;
    do {
      const [next, keys] = await call(kv.scan, cursor, 'MATCH', globOf(prefix), 'COUNT', SCAN_COUNT);
      // SCAN may answer a key twice: UNLINK counts each one once
      if (keys.length > 0) deleted += await call(remove, keys);
      cursor = String(next);
    } while (cursor !== '0');
    return deleted;
  } finally {
    clearTimeout(timer);
    late.catch(() => {});
  }
}

module.exports = {KEY_POSITIONS, prefixFor, namespaceCommand, unprefixError, runNamespaced, purgeNamespace};
