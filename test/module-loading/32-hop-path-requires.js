// The hop path's own require() calls (the per-hop counts of 2026-11-15:
// about 30 per 10-hop composite call from these three sites, 5-8 us each on
// the runtime's main thread): each is required once, through
// lib/require-once.js, or at the top of its file. So a warm hop requires
// none of them. Checked in the source: every require() of these modules in
// these files is top-level or inside a requireOnce.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SITES = [
  ['lib/peer-channel-broker.js', ['./metering/provider', './device-manager']],
  ['lib/device-manager.js', ['./user-auth', './session']],
  // #271's session values on a call (tools/call with a session, and each hop)
  ['lib/mcp/gateway.js', ['../sessions', '../session-settings', '../call-limits']]
];

describe('module-loading 32: the hop path requires nothing on a warm call', () => {
  for (const [file, ids] of SITES) {
    it(`${file}: ${ids.join(', ')} are required once`, () => {
      const lines = fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8').split('\n');
      const bad = [];
      lines.forEach((line, i) => {
        for (const id of ids) {
          if (!line.includes(`require('${id}')`)) continue;
          const topLevel = /^const [^=]+= require\(/.test(line);
          const once = line.includes(`requireOnce(() => require('${id}'))`);
          if (!topLevel && !once) bad.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      });
      assert.deepStrictEqual(bad, [], `a require() on the hop path:\n  ${bad.join('\n  ')}`);
    });
  }
});
