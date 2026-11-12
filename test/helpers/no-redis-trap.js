// Preloaded (NODE_OPTIONS=--require) into a server that must use no Redis
// (--store local, test/store/05): any load of the redis client package, of
// ioredis or of bullmq (BullMQ's queue) ends the process with a marker line:
// local mode needs none of them, not even to build a name (review of B5).
'use strict';
const Module = require('module');
const load = Module._load;
Module._load = function(request, ...rest) {
  if (request === 'redis' || request === 'ioredis' || request === 'bullmq') {
    process.stderr.write(`NO-REDIS-TRAP: ${request} loaded\n`);
    process.exit(71);
  }
  const loaded = load.call(this, request, ...rest);
  if (request === 'redis' && loaded != null && !loaded.__noRedisTrap) {
    loaded.createClient = function() {
      process.stderr.write('NO-REDIS-TRAP: redis.createClient called\n');
      process.exit(70);
    };
    loaded.__noRedisTrap = true;
  }
  return loaded;
};
