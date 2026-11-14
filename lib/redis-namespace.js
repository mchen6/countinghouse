// ctx.redis is per module (#164): every module shares the store's key space
// (Redis db 5, or the local store's kv), so the main thread puts every key
// argument of every command a module sends under m:<module name>:, the name
// main loaded the module under (lib/module-manager.js hostModuleName), never
// one the worker states. Runtime-internal keys (jobinfo:* and the like) carry
// no such prefix, so a module cannot name them.
//
// The key positions are a table over every allowed command
// (lib/redis-api.js ALLOWED_COMMANDS): 'first' (the first argument is the one
// key), 'all' (every argument is a key), 'transaction' (multi: a list of
// commands, each put in the namespace in turn), 'refused'. A command whose
// keys cannot be found statically (a pattern, a script's dynamic keys) is
// refused, and none is on the allowed list; neither is a command missing from
// this table. None of the allowed commands answers with key names, so only an
// error's text can carry one, and it loses the prefix (unprefixError).
const KEY_POSITIONS = Object.freeze({
  get: 'first', set: 'first', pexpire: 'first',
  hget: 'first', hset: 'first', hdel: 'first', hmget: 'first', hmset: 'first', hgetall: 'first',
  lpush: 'first', rpush: 'first', lrange: 'first', llen: 'first', ltrim: 'first',
  zadd: 'first', zrange: 'first', zrem: 'first',
  del: 'all', mget: 'all',
  // multi([[name, ...args], ...]): the queued commands, run as one
  // transaction on the main thread
  multi: 'transaction',
  // EXEC on the shared connection, outside a transaction main runs: refused
  exec: 'refused'
});

const isKey = (k) => typeof(k) === 'string' || (typeof(k) === 'number' && Number.isFinite(k));

// The module's prefix, or null for a name that is not one. The name is
// URI-encoded, so it holds no ':' and no prefix is the start of another's:
// a module named victim:x is m:victim%3Ax:, never inside m:victim:.
function prefixFor(moduleName) {
  return (typeof(moduleName) === 'string' && moduleName !== '') ? `m:${encodeURIComponent(moduleName)}:` : null;
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
    return {args: [prefix + String(args[0]), ...args.slice(1)]};
  }
  if (where === 'all') {
    if (args.length === 0 || !args.every(isKey)) return {refused: `${op} needs keys, each a string or a number`};
    return {args: args.map((k) => prefix + String(k))};
  }
  return {refused: `${String(op).slice(0, 64)} is not available to a module (its keys cannot be put in the module's namespace)`};
}

// (op, the arguments the module sent, prefix) -> {args} (the command's own),
// {commands} (multi's, each [name, ...args]) or {refused: why}.
function namespaceCommand(op, data, prefix) {
  if (prefix == null) return {refused: 'no namespace for this module'};
  if (!Array.isArray(data)) return {refused: 'the arguments must be a list'};
  if (op !== 'multi') return keyed(op, spread(data), prefix);
  let n = data.length;
  while (n > 0 && data[n - 1] === undefined) n -= 1;
  const queued = data[0];
  if (n !== 1 || !Array.isArray(queued) || queued.length === 0) return {refused: 'multi takes one list of commands, each [name, ...arguments]'};
  const commands = [];
  for (const c of queued) {
    if (!Array.isArray(c) || typeof(c[0]) !== 'string') return {refused: 'multi takes one list of commands, each [name, ...arguments]'};
    const name = c[0].toLowerCase();
    if (name === 'multi' || name === 'exec') return {refused: `${name} cannot be queued in multi`};
    const one = keyed(name, spread(c.slice(1)), prefix);
    if (one.refused != null) return one;
    commands.push([name, ...one.args]);
  }
  return {commands};
}

// An error's text without the module's prefix.
function unprefixError(message, prefix) {
  return (typeof(message) === 'string' && prefix != null) ? message.split(prefix).join('') : message;
}

// A transaction's replies: an error among them loses the prefix too.
function unprefixReplies(replies, prefix) {
  if (!Array.isArray(replies)) return replies;
  return replies.map((r) => (r instanceof Error ? Object.assign(new Error(unprefixError(r.message, prefix)), r.code != null ? {code: r.code} : {}) : r));
}

// One module's command, run on the main thread's client in the module's
// namespace: the worker's (lib/device-manager.js) and single-thread mode's
// (lib/redis-api.js namespacedClient). callback(err, result).
function runNamespaced(client, prefix, op, data, callback) {
  const r = namespaceCommand(op, data, prefix);
  if (r.refused != null) return process.nextTick(callback, new Error(r.refused));
  if (client == null) return process.nextTick(callback, new Error('Redis is not available here'));
  const answer = (e, result) => {
    if (e) return callback(new Error(unprefixError(e.message, prefix)));
    return callback(null, r.commands != null ? unprefixReplies(result, prefix) : result);
  };
  return r.commands != null ? client.transaction(r.commands, answer) : client[op](r.args, answer);
}

module.exports = {KEY_POSITIONS, prefixFor, namespaceCommand, unprefixError, unprefixReplies, runNamespaced};
