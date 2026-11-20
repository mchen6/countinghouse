'use strict';
// A per-session module's partitions over the session's life (shared runtime
// R1 Task 6; #236 section 4a and section 6). Main thread only; wired by
// lib/route-manager.js startSessions.
//
// - A session that ends: its workers stop (lib/session-workers.js), and
//   only once every one has exited, its partition of each per-session
//   module is removed (lib/session-partition.js): its store keys under
//   ms:<name>:<id>: and its files under <name>/sessions/<id>/. Removed on
//   every end ('bye', 'window', 'unsettled') but the runtime's own stop
//   ('closed'), since the next start may restore it. A call it had in
//   flight ends with the worker, as an unload's does. Nothing here is ever
//   fatal: a partition that can't be removed is logged, and the next
//   start's sweep tries again. What a removed one held leaves its module's
//   shared fs quota (the security pass of 11-17): the session's own share of
//   it, given back once the removal is whole, never after a partial one
//   (module-manager creditSessionEnd).
// - A start: once the listener accepts, in the background, every partition
//   of a session that is neither restored nor open is removed (the sweep;
//   the reviewer's ruling of 11-17: a long sweep before listen() could run
//   past restored sessions' reconnect windows). One that can't be removed is
//   logged, never fatal: no one session's files can stop the runtime.
// - D3 (#349): when nothing was restored (the daemon died, so no table came
//   back) and partitions are there to sweep, the next session to open is
//   told, once, that per-session state was reset (decided before the
//   listener accepts, from a listing, not the sweep).
// No session id is written to a log line here: a module's name and the
// reason only.
const fs = require('fs');
const LOG = require('./logger');
const options = require('./cli-options');
const partition = require('./session-partition');

// The Reviewer's wording (2026-11-17), with its reviewed translation, kept as
// data as lib/error-catalogue.js keeps its texts. Session notices are said in
// English (en), as lib/session-state.js's restore notices are; zh is for when
// they are localized.
const RESET_AT_START_TEXT = Object.freeze({
  en: 'Per-session module state was reset: the runtime restarted without its earlier sessions, so modules that keep state per session start fresh.',
  zh: '按会话保存的模块状态已重置：运行时重启时没有恢复之前的会话，因此按会话保存状态的模块将重新开始。'
});
const RESET_AT_START = RESET_AT_START_TEXT.en;
// env (tests): {dataRoot, kv}; by default the runtime's own
const rootOf = (env) => (env != null && env.dataRoot != null) ? env.dataRoot : options.moduleDataPath;
const kvOf = (env) => (env != null && env.kv != null) ? env.kv : require('./store').getStore().kv;

let resetPending = false;

// The registry's 'gone' (id, reason). -> Promise of what its end did, never
// rejected: 'removed' (its partitions dealt with: removed, or left for the
// next start's sweep when a removal failed), 'kept' (a worker didn't stop, or
// a broker was still busy: kept, never under a running op), or 'nothing'
// ('closed', or no per-session pool: the daemon keeps it, to restore).
// Only after 'removed' is the start's sweep free to take what is left.
async function ended(mm, id, reason, env) {
  try {
    return await endedNow(mm, id, reason, env);
  } catch (e) {
    LOG.E(e);
    return 'kept';
  } finally {
    // the modules it ran here: forgotten whatever the end did
    try { if (mm != null && typeof(mm.forgetSessionModules) === 'function') mm.forgetSessionModules(id); } catch (e) { /* stub */ }
  }
}
async function endedNow(mm, id, reason, env) {
  if (mm == null || mm.sessionWorkers == null) return 'nothing';
  // the workers first: a partition is never removed under one still running,
  // nor under a crashed one's broker still finishing an op
  let settled;
  // one list for the settle check and the removals
  const names = mm.perSessionModuleNames();
  try {
    await mm.sessionWorkers.stopSession(id);
    settled = await mm.sessionSettled(id, names);
  } catch (e) {
    LOG.E(new Error(`a session's per-session workers did not all stop (${e.message}); its partitions are kept for the next start's sweep`));
    return 'kept';
  }
  // removed on every end but the runtime's own stop ('closed': the next
  // start may restore it): 'bye', 'window', and 'unsettled' (a session never
  // opened, which can't come back)
  if (reason === 'closed') return 'nothing';
  const credits = [];
  let kept = false;
  for (const name of names) {
    // a broker of it still busy past the bound: its partition is kept, for
    // the next start's sweep, never removed under an op still running
    if (settled != null && settled[name] === false) {
      kept = true;
      LOG.E(new Error(`module: ${name}: a session's worker's files were still in use; its partition is kept for the next start's sweep`));
      continue;
    }
    // a module it never ran here, and with no partition on disk (one
    // restored may have one): nothing to do
    if (!mm.sessionRanModule(id, name) && !(await partitionThere(rootOf(env), name, id))) continue;
    let r;
    try {
      r = await partition.remove(rootOf(env), kvOf(env), name, id, {code: require('./data-ownership').knownCode(mm, options), say: (text) => LOG.I(`module: ${name}: ${text}`)});
    } catch (e) {
      // removed in part, or not at all: nothing given back (an over-count is
      // the safe direction); the next start's sweep tries again
      LOG.E(new Error(`module: ${name}: a session's partition was not removed (${String(e.code || e.message).slice(0, 200)}); the next start's sweep tries again`));
      continue;
    }
    // files the runtime did not make, kept (said once): nothing given back
    // while they are there (A-overlap-rm)
    if (r.kept.length > 0) { kept = true; continue; }
    // what it held leaves the module's shared fs quota: its session's share,
    // exactly (module-manager creditSessionEnd), once the removal is whole.
    // Its workers have already stopped (above): a slow build walk the credit
    // waits for never keeps one running.
    credits.push(Promise.resolve().then(() => mm.creditSessionEnd(name, id)).catch((e) => LOG.E(e)));
  }
  // every partition removed first, then the credits awaited together: one
  // module's build walk never holds up another module's removal
  await Promise.all(credits);
  return kept ? 'kept' : 'removed';
}

// whether <name>/sessions/<id> is on disk (anything but missing)
async function partitionThere(dataRoot, name, id) {
  let dirs;
  try { dirs = require('./module-data').sessionDirsFor(dataRoot, name, id); } catch (e) { return false; }
  // (only a missing one is absent: anything else, a file in the way
  // included, is tried, and its removal says what is wrong)
  return fs.promises.lstat(dirs.root).then(() => true, (e) => e.code !== 'ENOENT');
}

// Before the listener accepts: D3. With nothing restored, a listing of the
// partitions there (no removal) decides whether the next session to open is
// told its per-session state was reset. -> Promise, never rejected
// restoredNone: the registry is idle after the restore (registry.idle()). A
// listing that fails tells the first session anyway (the safe side: told
// of a reset that may not have been, never left unaware of one that was).
async function checkResetAtStart(restoredNone, env) {
  if (restoredNone !== true) return;
  try {
    // (the first partition found decides it: no full listing on the way to
    // listen)
    if (await partition.any(rootOf(env), kvOf(env))) resetPending = true;
  } catch (e) {
    resetPending = true;
    LOG.E(new Error(`per-session state: the start's listing did not run (${String(e.message).slice(0, 200)}); the next session is told of a reset`));
  }
}

// After the listener accepts, in the background: every partition whose
// session isn't kept (keep.has(id): restored, or open now: a new session's id
// is random, so none clashes) is removed. -> Promise of the sweep's
// {removed, failed, skipped} counts, never rejected. It removes every such
// partition in the store, so the store must be this runtime's alone:
// framework.js refuses --sessionSocket unless --store local (pinned by
// session-runtime 01). Relax one only with the other.
// opts.mm: the module manager, whose quotas give back each removed
// partition's share (a live session's spawn may have built one, counting it,
// before the sweep reached it).
async function sweepAtStart(keep, env, opts = {}) {
  const started = Date.now();
  let result = null;
  try {
    // each removed partition's share given back right after its removal,
    // not at the sweep's end: live sessions aren't refused meanwhile
    const mm = opts.mm;
    // (started as each removal finishes, awaited together: a credit waits for
    // its quota's build walk, which the sweep's next removal never does)
    const credits = [];
    const onRemoved = (mm != null && typeof(mm.creditSessionEnd) === 'function')
      ? (p) => { credits.push(Promise.resolve().then(() => mm.creditSessionEnd(p.name, p.sessionId)).catch((e) => LOG.E(e))); } : null;
    // (a partition from before ownership marks adopted only where no module
    // the runtime knows overlaps it: A-overlap-rm)
    const code = require('./data-ownership').knownCode(mm, options);
    result = await partition.sweep(rootOf(env), kvOf(env), keep, {onRemoved, code, say: (text) => LOG.I(`per-session state: ${text}`)});
    await Promise.all(credits);
  } catch (e) {
    LOG.E(new Error(`per-session state: the start's sweep did not run (${String(e.message).slice(0, 200)})`));
    return {removed: 0, failed: 0, skipped: 0};
  }
  for (const f of result.failed) LOG.E(new Error(`module: ${f.name}: a partition of an ended session was not removed (${f.why})`));
  for (const s of result.skipped) LOG.E(new Error(`per-session state: ${s.path} is ${s.why === 'a link' ? 'a link' : 'not a directory'}, so nothing under it is swept; remove or replace it`));
  LOG.I(`per-session state: the start's sweep removed ${result.removed.length} partition(s) of ended sessions in ${Date.now() - started} ms`);
  return {removed: result.removed.length, failed: result.failed.length, skipped: result.skipped.length};
}

// The start's sweep's keep set, wired by route-manager (R1 Task 6, the
// reviewer's ruling of 11-17): every session this process opened or restored
// is its own end's to remove, never the sweep's, so none is swept under its
// own end, nor under a worker still running. An id leaves the set only once
// its end says 'removed'; 'kept' (a worker didn't stop, a broker still busy)
// and 'nothing' ('closed': the daemon keeps it, to restore) keep it.
// Kept too: a session the registry holds, and all once it is closing. The
// set is only for the sweep's run: done() clears it.
// end(id, reason) -> Promise of ended()'s outcome (tests give their own)
function sweepGuard(registry, mm, end = (id, reason) => ended(mm, id, reason)) {
  const knownHere = new Set();
  let sweeping = true;
  return {
    opened(id) { if (sweeping) knownHere.add(id); },
    restored(ids) { for (const id of ids) knownHere.add(id); },
    gone(id, reason) {
      return Promise.resolve().then(() => end(id, reason)).then((did) => {
        if (did === 'removed') knownHere.delete(id);
        return did;
      }, () => undefined);
    },
    keep: {has: (id) => registry.closed() || registry.holds(id) || knownHere.has(id)},
    done() { sweeping = false; knownHere.clear(); }
  };
}

// The registry's 'session': the first one after a start that reset
// per-session state is told so, once, on its first result.
function sessionOpened(id) {
  if (!resetPending) return;
  resetPending = false;
  require('./notices').add(null, RESET_AT_START, {session: id, sessionOnly: true});
}

module.exports = {ended, checkResetAtStart, sweepAtStart, sweepGuard, sessionOpened, RESET_AT_START, RESET_AT_START_TEXT, resetForTests: () => { resetPending = false; }};
