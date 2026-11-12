'use strict';

// LM1 B1: no file outside the store and the Redis implementations behind it
// creates a Redis client or a job queue (a static scan of lib/).

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const LIB = path.resolve(__dirname, '../../lib');
const ALLOWED = new Set(['store.js', 'redis-resilient.js', 'metering/redis-provider.js', 'job-control.js',
  'redis-api.js', 'logger-stream-redis.js']);
const PATTERNS = [/require\(['"]redis['"]\)/, /require\(['"]bullmq['"]\)/, /\bredis(?:Resilient)?\.createClient\(/];

function files(dir, rel = '') {
  return fs.readdirSync(path.join(dir, rel), {withFileTypes: true}).flatMap((d) => {
    const r = rel === '' ? d.name : `${rel}/${d.name}`;
    if (d.isDirectory()) return files(dir, r);
    return r.endsWith('.js') ? [r] : [];
  });
}

describe('store 02: the store is the only place a Redis client or a job queue is made (LM1 B1)', () => {
  it('lib/ outside the store and the Redis implementations names neither', () => {
    const offenders = [];
    for (const f of files(LIB)) {
      if (ALLOWED.has(f)) continue;
      const src = fs.readFileSync(path.join(LIB, f), 'utf8');
      // comments may name them
      const code = src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
      for (const p of PATTERNS) if (p.test(code)) offenders.push(`${f}: ${p}`);
    }
    assert.deepStrictEqual(offenders, []);
  });
});
