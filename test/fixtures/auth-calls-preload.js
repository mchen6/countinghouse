'use strict';
// Preloaded into a server by test/auth/59 (node --require): every call of
// the auth provider's authenticate or listDevices appends a line to
// CH_TEST_AUTH_CALLS, so the test counts the provider lookups a request
// cost. Nothing without it.
const out = process.env.CH_TEST_AUTH_CALLS;
if (out) {
  const fs = require('fs');
  const auth = require('../../lib/auth');
  const getAuthProvider = auth.getAuthProvider;
  auth.getAuthProvider = function(...args) {
    const p = getAuthProvider.apply(this, args);
    if (p != null && p.authCallsCounted !== true) {
      const authenticate = p.authenticate;
      p.authenticate = function(...a) { fs.appendFileSync(out, 'a\n'); return authenticate.apply(this, a); };
      const listDevices = p.listDevices;
      if (typeof(listDevices) === 'function') p.listDevices = function(...a) { fs.appendFileSync(out, 'l\n'); return listDevices.apply(this, a); };
      p.authCallsCounted = true;
    }
    return p;
  };
}
