var fs      = require('fs');
var exec    = require('child_process').exec;

// A module that fails to load used to disappear silently: the log said
// "module: <name>@1.0.0 loaded" and then nothing ever appeared in tools/list,
// with no error at any level. Filtering the whole server log for level >= 40
// returned literally nothing. A module author had no way to find out why.
//
// Two distinct failure modes were behind that, and this file covers both by
// reading the actual server log rather than by probing the API:
//
//   A. package.json "main" points at device.js instead of index.js -- so the
//      loaded object registers no 'discover' listener and the
//      discover -> deviceonline handshake never happens. This was the
//      *completely* silent one, and it is the shape README itself used to
//      document (its module layout omitted index.js entirely).
//   B. api.json fails the framework's meta-schema. This did log, but only
//      errors[0].message with no instancePath -- "must have required property
//      'argumentList'" with no way to tell which action.
//
// Fixtures live in test/fixtures/, deliberately broken in exactly one way each.
var SP  = '/tmp/countinghouse-test-modload-' + process.pid;
var LOG_INVALID  = SP + '-invalid.log';
var LOG_NO_INDEX = SP + '-noindex.log';

// --debug and no --port collision with any other test file; the server is only
// started so it will try to load the fixture, no request is ever made to it.
//
// Deliberately runs framework.js directly instead of via ./bin/countinghouse,
// unlike every other test file here: that launcher pipes stdout through
// `bunyan` whenever bunyan is on PATH, and npm/npx put node_modules/.bin on
// PATH, so under `npm test` the log arrives pretty-printed instead of as JSON
// and nothing below can parse it. This file is the only one that reads the
// server's log as data rather than talking to its API, so it is the only one
// that cares. NODE_PATH mirrors what bin/countinghouse and the npm scripts set.
function startAndCapture(modulePath, port, logPath, done) {
  exec('NODE_PATH=./lib node ./framework.js --debug --bindAddr 127.0.0.1 --port ' + port +
       ' --loadModule ' + modulePath + ' > ' + logPath + ' 2>&1',
       function() {});
  setTimeout(done, 11000);
}

function errorRecords(logPath) {
  var out = [];
  var raw;
  try { raw = fs.readFileSync(logPath, 'utf8'); } catch (e) { return out; }

  raw.split('\n').forEach(function(line) {
    if (line.trim() === '') return;
    var rec;
    try { rec = JSON.parse(line); } catch (e) { return; }
    if (rec.level == null || rec.level < 40) return;
    // LOG.E puts the payload on `e`; LOG.DE on `de`
    var text = (typeof(rec.e) === 'string') ? rec.e
             : (rec.de != null ? JSON.stringify(rec.de) : JSON.stringify(rec));
    out.push(text);
  });
  return out;
}

describe('module-loading 01: a module that fails to load says why, with a locatable reason', function() {
  this.timeout(0);

  describe('A. package.json "main" points at device.js (no index.js)', function() {
    before(function(done) {
      this.timeout(0);
      startAndCapture('./test/fixtures/no-index-module', 9571, LOG_NO_INDEX, done);
    });

    after(function(done) {
      try { fs.unlinkSync(LOG_NO_INDEX); } catch (e) {}
      exec('pkill -f "framework.js --debug --bindAddr 127.0.0.1 --port 9571"', function() { done(); });
    });

    it('logs an error naming the module (previously: no error at any level)', function() {
      var errors = errorRecords(LOG_NO_INDEX);
      if (errors.length === 0) {
        throw new Error('a module that can never come online must not load silently -- no error-level record found');
      }
      var hit = errors.filter(function(e) { return e.indexOf('no-index-module') !== -1; });
      if (hit.length === 0) {
        throw new Error('the error must name the offending module, got: ' + JSON.stringify(errors));
      }
    });

    it('the message says what is wrong and how to fix it', function() {
      var text = errorRecords(LOG_NO_INDEX).join('\n');
      ['discover', 'deviceonline', 'index.js', 'main'].forEach(function(needle) {
        if (text.indexOf(needle) === -1) {
          throw new Error('expected the diagnostic to mention "' + needle + '", got: ' + text);
        }
      });
    });
  });

  describe('B. api.json fails the meta-schema', function() {
    before(function(done) {
      this.timeout(0);
      startAndCapture('./test/fixtures/invalid-spec-module', 9572, LOG_INVALID, done);
    });

    after(function(done) {
      try { fs.unlinkSync(LOG_INVALID); } catch (e) {}
      exec('pkill -f "framework.js --debug --bindAddr 127.0.0.1 --port 9572"', function() { done(); });
    });

    it('logs an error naming the module and the failing stage', function() {
      var text = errorRecords(LOG_INVALID).join('\n');
      if (text.indexOf('invalid-spec-module') === -1) {
        throw new Error('the error must name the offending module, got: ' + text);
      }
      if (text.indexOf('stage=validateDeviceSpec') === -1) {
        throw new Error('the error must name the failing stage, got: ' + text);
      }
    });

    it('reports a locatable position, not just "invalid"', function() {
      var text = errorRecords(LOG_INVALID).join('\n');
      // ajv instancePath is a JSON pointer into the submitted spec; the whole
      // point is that the author can find the offending node.
      if (text.indexOf('/device') === -1) {
        throw new Error('expected an ajv instancePath (JSON pointer) in the diagnostic, got: ' + text);
      }
      // and it must carry ajv's own message, not a generic one
      if (text.indexOf('must have required property') === -1) {
        throw new Error('expected ajv\'s own message text in the diagnostic, got: ' + text);
      }
    });

    it('reports every schema error, not only the first', function() {
      var text = errorRecords(LOG_INVALID).join('\n');
      var m = /(\d+) schema error\(s\)/.exec(text);
      if (m == null) {
        throw new Error('expected an "N schema error(s)" summary, got: ' + text);
      }
      // the fixture is broken in more than one place on purpose
      if (parseInt(m[1], 10) < 1) {
        throw new Error('expected at least one reported schema error, got: ' + m[1]);
      }
    });
  });
});
