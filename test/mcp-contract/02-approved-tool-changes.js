// The complete 4.x -> 5.0.0 MCP tool-surface delta, pinned.
//
// 01-tools-list-unchanged.js proves the *spec format change* moved nothing,
// but its baseline (tools-list.golden.json, captured at 6f948fc) was taken
// after phases 1b/1c had already removed an action, so it could not see that
// removal. This file closes that gap: tools-list.pre-5.0.0.json was captured
// at 31f1316 -- the commit before phase 1a, i.e. before any 5.0.0 work at all
// -- and this asserts that the only difference between the 4.x surface and
// the 5.0.0 surface is a single, named, approved removal -- plus the output
// schema changes in APPROVED_SCHEMA_CHANGES below.
//
// Recapture (only when a surface change is intended, and say why in the
// commit message):
//   git worktree add /tmp/pre 31f1316
//   ln -s "$PWD/node_modules" /tmp/pre/node_modules
//   mkdir -p /tmp/pre/test/mcp-contract
//   cp test/mcp-contract/capture-tools-list.js /tmp/pre/test/mcp-contract/
//   (cd /tmp/pre && node test/mcp-contract/capture-tools-list.js \
//        "$PWD/../test/mcp-contract/tools-list.pre-5.0.0.json")
//
// Pure data comparison -- no server, no redis.
const assert = require('assert');

const PRE    = require('./tools-list.pre-5.0.0.json'); // 4.x surface, commit 31f1316
const GOLDEN = require('./tools-list.golden.json');    // 5.0.0 surface, pinned by 01

// Removals the maintainer has approved, each with the reason it was approved.
// A removal that is not on this list fails the first test below -- which is
// the point: dropping a tool is a breaking change for every client that calls
// it, and must be a decision, not a side effect.
const APPROVED_REMOVALS = {
  // Existed only to demonstrate the per-action apiCache response cache. That
  // cache was removed in 5.0.0 (it conflicts with per-call metering: a cache
  // hit returns a billable result without a call reaching the module), so the
  // action demonstrating it went with it. See MIGRATION.md.
  'echo_device_echoservice_echowithapicache': 'demonstrated --apiCache, removed with it'
};

// Additions the maintainer has approved, each with the reason. A tool that
// appears without being on this list fails the second test below: a new tool
// is a surface change every client sees, and must be a decision too.
const APPROVED_ADDITIONS = {
  // Local-mode spec §5 (LM1 part C, step 3): the usage report, listed to
  // every key in every mode, beside countinghouse_check_balance.
  'countinghouse_usage_report': 'the usage report built-in, local-mode spec §5'
};

// Output-schema changes the maintainer has approved, each with its reason and
// the exact value now advertised (undefined: no outputSchema at all). A
// changed schema that is not on this list fails the third test below, and so
// does an entry for a schema that did not change.
const APPROVED_SCHEMA_CHANGES = {
  countinghouse_check_balance: {
    reason: 'no raw API key in tool output: returns {userName, balance} (spec 2026-11-06-mcp-conformance-design.md)',
    outputSchema: {type: 'object', properties: {userName: {type: ['string', 'null']}, balance: {type: ['number', 'null']}},
      required: ['userName', 'balance'], additionalProperties: false}
  }
};

function byName(list) {
  const out = {};
  list.forEach((t) => { out[t.name] = t; });
  return out;
}

describe('mcp-contract 02: the whole 4.x -> 5.0.0 tool-surface delta is the approved removals and additions', () => {

  const pre = byName(PRE);
  const now = byName(GOLDEN);

  it('removes exactly the approved tools, and no others', () => {
    const removed = Object.keys(pre).filter((n) => { return now[n] == null; }).sort();
    assert.deepStrictEqual(removed, Object.keys(APPROVED_REMOVALS).sort(),
      'a tool disappeared without being approved in APPROVED_REMOVALS, or an approved ' +
      'removal did not happen. Removing a tool breaks every client calling it.');
  });

  it('adds no tools silently', () => {
    const added = Object.keys(now).filter((n) => { return pre[n] == null; }).sort();
    assert.deepStrictEqual(added, Object.keys(APPROVED_ADDITIONS).sort(),
      `a tool appeared that the 4.x surface did not have and APPROVED_ADDITIONS does not name, or an approved addition is missing: ${JSON.stringify(added)}`);
  });

  it('leaves every surviving tool field-for-field identical to its 4.x definition, apart from approved schema changes', () => {
    Object.keys(pre).forEach((name) => {
      if (now[name] == null) return; // an approved removal, covered above
      assert.strictEqual(now[name].description, pre[name].description, `${name}: description moved`);
      assert.deepStrictEqual(now[name].inputSchema,  pre[name].inputSchema,  `${name}: inputSchema moved`);
      const approved = APPROVED_SCHEMA_CHANGES[name];
      if (approved != null) {
        assert.deepStrictEqual(now[name].outputSchema, approved.outputSchema, `${name}: outputSchema is not the approved one`);
      } else {
        assert.deepStrictEqual(now[name].outputSchema, pre[name].outputSchema, `${name}: outputSchema moved`);
      }
    });
  });

  it('names only output schemas that actually changed', () => {
    Object.keys(APPROVED_SCHEMA_CHANGES).forEach((name) => {
      assert.ok(pre[name] != null && now[name] != null, `${name}: not on both surfaces`);
      assert.notDeepStrictEqual(pre[name].outputSchema, now[name].outputSchema, `${name}: approved a change that did not happen`);
    });
  });

  it('still protects the full surviving surface (21 module tools + 2 platform tools)', () => {
    assert.strictEqual(GOLDEN.length, 23);
    assert.strictEqual(PRE.length, 23);
  });
});
