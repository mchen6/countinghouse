// The complete 4.x -> 5.0.0 MCP tool-surface delta, pinned.
//
// 01-tools-list-unchanged.js proves the *spec format change* moved nothing,
// but its baseline (tools-list.golden.json, captured at 6f948fc) was taken
// after phases 1b/1c had already removed an action, so it could not see that
// removal. This file closes that gap: tools-list.pre-5.0.0.json was captured
// at 31f1316 -- the commit before phase 1a, i.e. before any 5.0.0 work at all
// -- and this asserts that the only difference between the 4.x surface and
// the 5.0.0 surface is a single, named, approved removal.
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
var assert = require('assert');

var PRE    = require('./tools-list.pre-5.0.0.json'); // 4.x surface, commit 31f1316
var GOLDEN = require('./tools-list.golden.json');    // 5.0.0 surface, pinned by 01

// Removals the maintainer has approved, each with the reason it was approved.
// A removal that is not on this list fails the first test below -- which is
// the point: dropping a tool is a breaking change for every client that calls
// it, and must be a decision, not a side effect.
var APPROVED_REMOVALS = {
  // Existed only to demonstrate the per-action apiCache response cache. That
  // cache was removed in 5.0.0 (it conflicts with per-call metering: a cache
  // hit returns a billable result without a call reaching the module), so the
  // action demonstrating it went with it. See MIGRATION.md.
  'echo_device_echoservice_echowithapicache': 'demonstrated --apiCache, removed with it'
};

function byName(list) {
  var out = {};
  list.forEach(function(t) { out[t.name] = t; });
  return out;
}

describe('mcp-contract 02: the whole 4.x -> 5.0.0 tool-surface delta is one approved removal', function() {

  var pre = byName(PRE);
  var now = byName(GOLDEN);

  it('removes exactly the approved tools, and no others', function() {
    var removed = Object.keys(pre).filter(function(n) { return now[n] == null; }).sort();
    assert.deepStrictEqual(removed, Object.keys(APPROVED_REMOVALS).sort(),
      'a tool disappeared without being approved in APPROVED_REMOVALS, or an approved ' +
      'removal did not happen. Removing a tool breaks every client calling it.');
  });

  it('adds no tools silently', function() {
    var added = Object.keys(now).filter(function(n) { return pre[n] == null; }).sort();
    assert.deepStrictEqual(added, [],
      'a tool appeared that the 4.x surface did not have: ' + JSON.stringify(added));
  });

  it('leaves every surviving tool field-for-field identical to its 4.x definition', function() {
    Object.keys(pre).forEach(function(name) {
      if (now[name] == null) return; // an approved removal, covered above
      assert.strictEqual(now[name].description, pre[name].description, name + ': description moved');
      assert.deepStrictEqual(now[name].inputSchema,  pre[name].inputSchema,  name + ': inputSchema moved');
      assert.deepStrictEqual(now[name].outputSchema, pre[name].outputSchema, name + ': outputSchema moved');
    });
  });

  it('still protects the full surviving surface (21 module tools + 1 platform tool)', function() {
    assert.strictEqual(GOLDEN.length, 22);
    assert.strictEqual(PRE.length, 23);
  });
});
