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
  {pattern: /require\(['"]redis['"]\)/, allowed: ['redis-resilient.js']},
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

  // Every node_redis client the repo makes is a lib/redis-resilient one, whose
  // offline-queue drain can't spin: outside lib/ (the
  // runtime, its CLIs, scripts and tools; not tests or examples) nothing
  // requires or imports node_redis, or a file inside it.
  it('outside lib/, the runtime, its CLIs, scripts and tools never require node_redis themselves', () => {
    const ROOT = path.resolve(LIB, '..');
    const NODE_REDIS = /require\(\s*['"]redis(\/[^'"]*)?['"]\s*\)|\bfrom\s+['"]redis(\/[^'"]*)?['"]|\bimport\s*\(\s*['"]redis(\/[^'"]*)?['"]/;
    const all = (d) => fs.readdirSync(path.join(ROOT, d), {withFileTypes: true}).flatMap((e) => (e.isDirectory() ? all(`${d}/${e.name}`) : [`${d}/${e.name}`]));
    const own = ['framework.js', ...['bin', 'scripts', 'tools'].flatMap(all)].filter((f) => !/\.(md|json)$/.test(f));
    const offenders = own.filter((f) => {
      const code = fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
      return NODE_REDIS.test(code);
    });
    assert.deepStrictEqual(offenders, []);
  });
});
