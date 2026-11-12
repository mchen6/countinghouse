'use strict';

// LM1 B1: no file outside the store and the Redis implementations behind it
// creates a Redis client or a job queue (a static scan of lib/).

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const LIB = path.resolve(__dirname, '../../lib');
// Each way to make a Redis client or a job queue, and the files allowed to
// use it: the store and the Redis implementations behind it.
const RULES = [
  {pattern: /require\(['"]redis['"]\)/, allowed: ['store.js', 'redis-resilient.js']},
  {pattern: /require\(['"]bullmq['"]\)/, allowed: ['job-control.js']},
  {pattern: /require\(['"][./]*redis-resilient['"]\)/, allowed: ['store.js', 'metering/redis-provider.js']},
  // constructing the provider (its file's encodeLegacyTool helper is
  // required in several places and makes no client)
  {pattern: /new\s+RedisMeteringProvider\b|new\s*\(\s*require\([^)]*redis-provider/, allowed: ['store.js']},
  {pattern: /\bredis\w*\.createClient\(/i, allowed: ['store.js', 'redis-resilient.js', 'metering/redis-provider.js']}
];

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
      const src = fs.readFileSync(path.join(LIB, f), 'utf8');
      // comments may name them
      const code = src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
      for (const rule of RULES) if (!rule.allowed.includes(f) && rule.pattern.test(code)) offenders.push(`${f}: ${rule.pattern}`);
    }
    assert.deepStrictEqual(offenders, []);
  });
});
