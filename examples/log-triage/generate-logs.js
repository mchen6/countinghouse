#!/usr/bin/env node
// Sample data for the log-triage demo: a deterministic set of application log
// files with fake PII planted in them.
//
// Deterministic on purpose. The same --seed always writes byte-identical
// files, so a hop count or a cluster count seen on one machine is the count on
// every machine. The PRNG is in this file rather than a dependency for the
// same reason the leaf modules have none: one file a reader can follow.
//
// Every planted value is fake by construction -- example.com addresses, the
// 203.0.113.0/24 documentation range, 555 phone numbers, the standard test
// card number -- and is exported, so a checker can assert that none of them
// survives into a tool response.
const fs   = require('fs');
const path = require('path');

const PLANTED_PII = {
  email:       ['alice.nguyen@example.com', 'bob.ortiz@example.com', 'carol.w@example.com'],
  ipv4:        ['203.0.113.7', '203.0.113.42', '203.0.113.199'],
  phone:       ['+1-202-555-0143', '+1-202-555-0178'],
  card:        ['4111 1111 1111 1111'],
  bearerToken: ['tk_demo_9f8e7d6c5b4a39281706f5e4d3c2b1a0']
};

function allPlantedValues() {
  return [].concat(PLANTED_PII.email, PLANTED_PII.ipv4, PLANTED_PII.phone,
                   PLANTED_PII.card, PLANTED_PII.bearerToken);
}

// mulberry32: small, fast, and good enough to shuffle log templates.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// r: helpers bound to one generation run. `pii(type)` hands values out in
// rotation rather than at random, so every planted value is guaranteed to
// appear once enough PII lines have been written.
// Weights are relative; the WARN/ERROR templates are the ones error-cluster
// is expected to group.
const TEMPLATES = [
  {w: 30, level: 'INFO',  msg: (r) => `request completed in ${r.int(5, 900)}ms status=200 path=/api/orders/${r.int(1000, 99999)}`},
  {w: 14, level: 'DEBUG', msg: (r) => `cache hit key=session:${r.hex(8)}`},
  {w: 6,  level: 'INFO',  msg: (r) => `user login email=${r.pii('email')} from ${r.pii('ipv4')}`},
  {w: 3,  level: 'INFO',  msg: (r) => `sms verification sent to ${r.pii('phone')}`},
  {w: 3,  level: 'DEBUG', msg: (r) => `outbound call header Authorization: Bearer ${r.pii('bearerToken')}`},
  {w: 5,  level: 'WARN',  msg: (r) => `slow query took ${r.int(800, 9000)}ms table=orders`},
  {w: 4,  level: 'WARN',  msg: (r) => `rate limit near threshold for client ${r.pii('ipv4')}`},
  {w: 3,  level: 'WARN',  msg: (r) => `disk usage at ${r.int(80, 99)}% on /var/data`},
  {w: 3,  level: 'WARN',  msg: (r) => `retrying webhook delivery attempt ${r.int(2, 5)} to ${r.pii('email')}`},
  {w: 3,  level: 'WARN',  msg: (r) => `connection pool exhausted, ${r.int(1, 40)} requests waiting`},
  {w: 2,  level: 'WARN',  msg: (r) => `deprecated endpoint /api/v1/orders called by client ${r.int(100, 999)}`},
  {w: 4,  level: 'ERROR', msg: (r) => `upstream timeout after ${r.int(3000, 30000)}ms calling inventory-service request=${r.uuid()}`},
  {w: 3,  level: 'ERROR', msg: (r) => `payment declined for card ${r.pii('card')} order=${r.int(1000, 99999)}`},
  {w: 3,  level: 'ERROR', msg: (r) => `database connection lost to db-${r.int(1, 4)}.internal retry=${r.int(1, 5)}`},
  {w: 2,  level: 'ERROR', msg: (r) => `unhandled exception in worker ${r.int(1, 16)}: TypeError: cannot read properties of undefined`},
  {w: 2,  level: 'ERROR', msg: (r) => `failed to send receipt to ${r.pii('email')}: mailbox unavailable`},
  {w: 2,  level: 'ERROR', msg: (r) => `job ${r.hex(12)} exceeded max attempts, moved to dead letter queue`}
];

const TOTAL_WEIGHT = TEMPLATES.reduce((sum, t) => sum + t.w, 0);

const BASE_TIME_MS = Date.UTC(2026, 8, 1);   // 2026-09-01T00:00:00Z
const DAY_MS       = 24 * 60 * 60 * 1000;

function generate(opts) {
  const o     = opts || {};
  const dir   = path.resolve(o.dir != null ? o.dir : path.join(__dirname, 'sample-logs'));
  const files = o.files != null ? o.files : 8;
  const lines = o.lines != null ? o.lines : 400;
  const seed  = o.seed  != null ? o.seed  : 1;

  const rnd     = mulberry32(seed);
  const cursors = {};
  const r = {
    int: (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1)),
    hex: (n) => {
      let s = '';
      for (let i = 0; i < n; i++) s += Math.floor(rnd() * 16).toString(16);
      return s;
    },
    uuid: () => `${r.hex(8)}-${r.hex(4)}-${r.hex(4)}-${r.hex(4)}-${r.hex(12)}`,
    pii: (type) => {
      const values = PLANTED_PII[type];
      const i = cursors[type] || 0;
      cursors[type] = i + 1;
      return values[i % values.length];
    }
  };

  fs.mkdirSync(dir, {recursive: true});

  const written = [];
  for (let f = 0; f < files; f++) {
    let t   = BASE_TIME_MS + f * DAY_MS;
    let out = '';

    for (let l = 0; l < lines; l++) {
      t += r.int(50, 20000);

      let pick = rnd() * TOTAL_WEIGHT;
      let template = TEMPLATES[TEMPLATES.length - 1];
      for (const candidate of TEMPLATES) {
        pick -= candidate.w;
        if (pick < 0) { template = candidate; break; }
      }

      out += `${new Date(t).toISOString()} ${template.level} ${template.msg(r)}\n`;
    }

    const file = path.join(dir, `app-${String(f + 1).padStart(2, '0')}.log`);
    fs.writeFileSync(file, out);
    written.push(file);
  }

  return written;
}

module.exports = {generate: generate, PLANTED_PII: PLANTED_PII, allPlantedValues: allPlantedValues};

if (require.main === module) {
  const argv = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag  = argv[i];
    const value = argv[i + 1];
    if (flag === '--dir' && value != null) opts.dir = value;
    else if ((flag === '--files' || flag === '--lines' || flag === '--seed') && /^\d+$/.test(value || '')) {
      opts[flag.slice(2)] = Number(value);
    } else {
      console.error('usage: node generate-logs.js [--dir <path>] [--files <n>] [--lines <n>] [--seed <n>]');
      process.exit(2);
    }
  }
  const written = generate(opts);
  console.log(`wrote ${written.length} log file(s) to ${path.dirname(written[0] || path.resolve(opts.dir || path.join(__dirname, 'sample-logs')))}`);
}
