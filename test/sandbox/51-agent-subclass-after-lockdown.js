// An http.Agent subclass made after the lockdown keeps its own
// createConnection (#177's CI). On Node 24.0 and 22.16 http.Agent's
// createConnection is net.createConnection itself, so the lockdown guards it
// there; a library loaded after the lockdown (a module's own; postman-request
// for a module with no net under audit, #194's PR 1), with a subclass that
// assigns its own createConnection as it loads (https's Agent,
// forever-agent's ForeverAgentSSL under postman-request, any util.inherits
// agent), must get it, not the guarded plain connect: a TLS
// agent would otherwise connect in the clear. http.Agent's own stays guarded.
// On other versions the agent is not guarded there, and this passes as is.
const assert = require('assert');
const {inWorker, install} = require('../helpers/lockdown-worker');

const probe = (mode) => inWorker(`
  // guarded only where the agent's createConnection is net's own
  const guarded = require('http').Agent.prototype.createConnection === require('net').createConnection;
  ${install({mode: mode})}
  const http = require('http');
  const util = require('util');
  const out = {};
  const mine = function() {};
  try {
    const https = require('https');
    out.https = Object.prototype.hasOwnProperty.call(https.Agent.prototype, 'createConnection') &&
      https.Agent.prototype.createConnection !== http.Agent.prototype.createConnection;
  } catch (e) { out.https = 'threw: ' + e.message; }
  // sloppy, as forever-agent is: a refused assignment would be dropped silently
  function Sloppy() { http.Agent.call(this); }
  util.inherits(Sloppy, http.Agent);
  Sloppy.prototype.createConnection = mine;
  out.sloppy = Sloppy.prototype.createConnection === mine && new Sloppy().createConnection === mine;
  try {
    out.strict = (function() {
      'use strict';
      class Strict extends http.Agent {}
      Strict.prototype.createConnection = mine;
      return Strict.prototype.createConnection === mine;
    })();
  } catch (e) { out.strict = 'threw: ' + e.message; }
  const before = http.Agent.prototype.createConnection;
  try { http.Agent.prototype.createConnection = mine; } catch (e) { /* refused */ }
  out.baseKept = guarded ? (http.Agent.prototype.createConnection === before && before !== mine) : 'not guarded';
  out.guarded = guarded;
  return out;
`);

describe('sandbox 51: an http.Agent subclass made after the lockdown keeps its own createConnection', function() {
  this.timeout(60000);
  ['audit', 'enforce'].forEach((mode) => {
    it(`${mode}: https loads, a sloppy and a strict subclass assign their own, and http.Agent's own is kept`, () => {
      const out = probe(mode);
      assert.deepStrictEqual(out, {https: true, sloppy: true, strict: true, baseKept: out.guarded ? true : 'not guarded', guarded: out.guarded});
    });
  });
});
