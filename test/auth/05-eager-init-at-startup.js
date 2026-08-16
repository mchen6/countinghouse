const fs      = require('fs');
const exec    = require('child_process').exec;
const request = require('supertest');

const url = 'http://127.0.0.1:9527';

// Regression test: the AuthProvider (lib/auth/) used to be instantiated
// lazily, on the first authenticated request -- meaning FileAuthProvider's
// zero-config demo-key generation (see its own header comment) never ran,
// and its banner never printed, until *after* an operator had already
// tried (and failed) to make a request with no key in hand yet. A pure
// chicken-and-egg first-run experience: there was no way to discover the
// key without already having sent some request carrying *a* key (even a
// wrong one happened to trigger it, but nothing told you that).
//
// Fixed in framework.js: the configured AuthProvider is now instantiated
// eagerly at startup (skipped under --debug, which never uses it). This
// test starts a real server with a brand new --authConfigPath and asserts
// the generated auth.json already exists well before any HTTP request is
// made, not just after one.
describe('auth 05: AuthProvider initializes at startup, not lazily on first request', function() {
  this.timeout(0);

  const AUTH_CONFIG_PATH = `/tmp/countinghouse-test-auth-05-${process.pid}.json`;

  before(() => {
    try { fs.unlinkSync(AUTH_CONFIG_PATH); } catch (e) {} // guarantee a true first-run
  });

  after((done) => {
    try { fs.unlinkSync(AUTH_CONFIG_PATH); } catch (e) {}
    exec(`pkill -f "framework.js.*${AUTH_CONFIG_PATH}"`, () => { done(); });
  });

  it('auth.json exists shortly after server startup, before any request is sent', (done) => {
    exec(`"./bin/countinghouse" --workerThread --bindAddr 127.0.0.1 --authConfigPath ${AUTH_CONFIG_PATH
         } --loadModule ./pre-installed-packages/echo-device-module`,
         (err, stdout, stderr) => { console.log(err); });

    // Deliberately short and well before the ~13s this repo's other
    // standalone tests wait for full module discovery -- this assertion
    // is about AuthProvider initializing at process startup, which
    // happens long before module loading even begins, not about the
    // server being ready to serve requests yet.
    setTimeout(() => {
      if (!fs.existsSync(AUTH_CONFIG_PATH)) {
        return done(new Error(`expected ${AUTH_CONFIG_PATH} to already exist shortly after startup (eager AuthProvider init), before any request was made`));
      }
      return done();
    }, 2000);
  });
});
