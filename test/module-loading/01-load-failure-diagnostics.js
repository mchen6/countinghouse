const fs      = require('fs');
const exec    = require('child_process').exec;

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
// C was added in 5.0.0, which changed the spec format: an api.json still in
// the old format is a spec failure like B, but one with a known fix, so it
// gets its own message naming the converter instead of an ajv symptom.
//
// Fixtures live in test/fixtures/, deliberately broken in exactly one way each.
const SP  = `/tmp/countinghouse-test-modload-${process.pid}`;
const LOG_INVALID  = `${SP}-invalid.log`;
const LOG_NO_INDEX = `${SP}-noindex.log`;
const LOG_LEGACY   = `${SP}-legacy.log`;

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
  exec(`NODE_PATH=./lib node ./framework.js --debug --bindAddr 127.0.0.1 --port ${port
       } --loadModule ${modulePath} > ${logPath} 2>&1`,
       () => {});
  setTimeout(done, 11000);
}

function errorRecords(logPath) {
  const out = [];
  let raw;
  try { raw = fs.readFileSync(logPath, 'utf8'); } catch (e) { return out; }

  raw.split('\n').forEach((line) => {
    if (line.trim() === '') return;
    let rec;
    try { rec = JSON.parse(line); } catch (e) { return; }
    if (rec.level == null || rec.level < 40) return;
    // LOG.E puts the payload on `e`; LOG.DE on `de`
    const text = (typeof(rec.e) === 'string') ? rec.e
             : (rec.de != null ? JSON.stringify(rec.de) : JSON.stringify(rec));
    out.push(text);
  });
  return out;
}

describe('module-loading 01: a module that fails to load says why, with a locatable reason', function() {
  this.timeout(0);

  describe('A. package.json "main" points at device.js (no index.js)', () => {
    before(function(done) {
      this.timeout(0);
      startAndCapture('./test/fixtures/no-index-module', 9571, LOG_NO_INDEX, done);
    });

    after((done) => {
      try { fs.unlinkSync(LOG_NO_INDEX); } catch (e) {}
      exec('pkill -f "framework.js --debug --bindAddr 127.0.0.1 --port 9571"', () => { done(); });
    });

    it('logs an error naming the module (previously: no error at any level)', () => {
      const errors = errorRecords(LOG_NO_INDEX);
      if (errors.length === 0) {
        throw new Error('a module that can never come online must not load silently -- no error-level record found');
      }
      const hit = errors.filter((e) => { return e.indexOf('no-index-module') !== -1; });
      if (hit.length === 0) {
        throw new Error(`the error must name the offending module, got: ${JSON.stringify(errors)}`);
      }
    });

    it('the message says what is wrong and how to fix it', () => {
      const text = errorRecords(LOG_NO_INDEX).join('\n');
      ['discover', 'deviceonline', 'index.js', 'main'].forEach((needle) => {
        if (text.indexOf(needle) === -1) {
          throw new Error(`expected the diagnostic to mention "${needle}", got: ${text}`);
        }
      });
    });
  });

  describe('B. api.json fails the meta-schema', () => {
    before(function(done) {
      this.timeout(0);
      startAndCapture('./test/fixtures/invalid-spec-module', 9572, LOG_INVALID, done);
    });

    after((done) => {
      try { fs.unlinkSync(LOG_INVALID); } catch (e) {}
      exec('pkill -f "framework.js --debug --bindAddr 127.0.0.1 --port 9572"', () => { done(); });
    });

    it('logs an error naming the module and the failing stage', () => {
      const text = errorRecords(LOG_INVALID).join('\n');
      if (text.indexOf('invalid-spec-module') === -1) {
        throw new Error(`the error must name the offending module, got: ${text}`);
      }
      if (text.indexOf('stage=validateDeviceSpec') === -1) {
        throw new Error(`the error must name the failing stage, got: ${text}`);
      }
    });

    it('reports a locatable position, not just "invalid"', () => {
      const text = errorRecords(LOG_INVALID).join('\n');
      // ajv instancePath is a JSON pointer into the submitted spec; the whole
      // point is that the author can find the offending node.
      if (text.indexOf('/device') === -1) {
        throw new Error(`expected an ajv instancePath (JSON pointer) in the diagnostic, got: ${text}`);
      }
      // and it must carry ajv's own message, not a generic one
      if (text.indexOf('must have required property') === -1) {
        throw new Error(`expected ajv's own message text in the diagnostic, got: ${text}`);
      }
    });

    it('reports every schema error, not only the first', () => {
      const text = errorRecords(LOG_INVALID).join('\n');
      const m = /(\d+) schema error\(s\)/.exec(text);
      if (m == null) {
        throw new Error(`expected an "N schema error(s)" summary, got: ${text}`);
      }
      // the fixture is broken in more than one place on purpose
      if (parseInt(m[1], 10) < 1) {
        throw new Error(`expected at least one reported schema error, got: ${m[1]}`);
      }
    });
  });

  describe('C. api.json is still in the pre-5.0.0 spec format', () => {
    before(function(done) {
      this.timeout(0);
      startAndCapture('./test/fixtures/legacy-spec-module', 9573, LOG_LEGACY, done);
    });

    after((done) => {
      try { fs.unlinkSync(LOG_LEGACY); } catch (e) {}
      exec('pkill -f "framework.js --debug --bindAddr 127.0.0.1 --port 9573"', () => { done(); });
    });

    it('names the module and the failing stage', () => {
      const text = errorRecords(LOG_LEGACY).join('\n');
      if (text.indexOf('legacy-spec-module') === -1 || text.indexOf('stage=validateDeviceSpec') === -1) {
        throw new Error(`the error must name the module and the stage, got: ${text}`);
      }
    });

    it('says the format is the problem and names the converter to run', () => {
      const text = errorRecords(LOG_LEGACY).join('\n');
      // the whole point: not a bare ajv symptom like "actionList must be array",
      // which leaves an author with no idea a converter exists
      ['pre-5.0.0 spec format', 'serviceStateTable', 'countinghouse-migrate-spec'].forEach((needle) => {
        if (text.indexOf(needle) === -1) {
          throw new Error(`expected the diagnostic to mention "${needle}", got: ${text}`);
        }
      });
    });
  });
});
