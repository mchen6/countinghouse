// Wait for a spawned countinghouse server to say it is ready, instead of
// sleeping a fixed number of seconds after starting it.
//
// The server logs READY_LINE (lib/device-manager.js, onAllModulesDiscovered)
// once every preloaded module is discovered AND every device's composition
// verdict has been delivered -- the second half is what a fixed sleep after
// "all module discovered" used to guess at, and what ctx.call answers
// CTX_CALL_NOT_READY for until it is done. The line is logged again after
// each later discovery pass (a module loaded at run time), which is what
// `count` is for.
//
// Works on any child with a piped stdout: child_process.exec(), spawn() with
// stdio 'pipe', or fork() with {silent: true}.
//
//   const waitForReady = require('../helpers/wait-for-ready');
//   before((done) => { waitForReady(exec('"./bin/countinghouse" ...'), done); });
//
// done(err) is called exactly once: with nothing when the line has been seen
// `count` times, or with an Error carrying the tail of the server's output
// when the child exits first or the deadline passes.
const fs = require('fs');

const READY_LINE = 'countinghouse ready';

const DEFAULT_TIMEOUT_MS = 90000;
const TAIL_CHARS         = 2000;

function countOccurrences(text, needle) {
  let n = 0;
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at === -1) return n;
    n++;
    from = at + needle.length;
  }
}

function waitForReady(child, opts, done) {
  if (typeof opts === 'function') { done = opts; opts = {}; }
  opts = opts || {};

  const wanted    = (opts.count != null) ? opts.count : 1;
  const timeoutMs = (opts.timeoutMs != null) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;

  let out     = '';
  let settled = false;
  let timer   = null;

  function finish(err) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    child.removeListener('exit', onExit);
    // keep draining: a server whose stdout pipe fills up blocks on its next log
    return done(err);
  }

  function failure(why) {
    return new Error(`${why}; last output:\n${out.slice(-TAIL_CHARS)}`);
  }

  function onData(chunk) {
    if (settled) return;
    out += chunk;
    if (countOccurrences(out, READY_LINE) >= wanted) finish();
  }

  function onExit(code, signal) {
    finish(failure(`server exited (code ${code}, signal ${signal}) before it was ready`));
  }

  if (child.stdout == null) {
    settled = true;
    return done(new Error('waitForReady needs a child with a piped stdout'));
  }

  child.stdout.on('data', onData);
  if (child.stderr != null) child.stderr.on('data', (chunk) => { if (!settled) out += chunk; });
  child.on('exit', onExit);

  timer = setTimeout(() => {
    finish(failure(`server was not ready within ${timeoutMs} ms (saw "${READY_LINE}" ${
      countOccurrences(out, READY_LINE)} of ${wanted} time(s))`));
  }, timeoutMs);
}

// Same contract for a server whose output was redirected to a file by the
// shell (`... > server.log 2>&1`), where there is no pipe to listen on: poll
// the file instead.
function waitForReadyInFile(logPath, opts, done) {
  if (typeof opts === 'function') { done = opts; opts = {}; }
  opts = opts || {};

  const wanted    = (opts.count != null) ? opts.count : 1;
  const timeoutMs = (opts.timeoutMs != null) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const deadline  = Date.now() + timeoutMs;

  (function poll() {
    let out = '';
    try { out = fs.readFileSync(logPath, 'utf8'); } catch (e) { /* not created yet */ }

    if (countOccurrences(out, READY_LINE) >= wanted) return done();
    if (Date.now() > deadline) {
      return done(new Error(`server was not ready within ${timeoutMs} ms (saw "${READY_LINE}" ${
        countOccurrences(out, READY_LINE)} of ${wanted} time(s) in ${logPath}); last output:\n${
        out.slice(-TAIL_CHARS)}`));
    }
    return setTimeout(poll, 200);
  })();
}

module.exports = waitForReady;
module.exports.inFile = waitForReadyInFile;
module.exports.READY_LINE = READY_LINE;
