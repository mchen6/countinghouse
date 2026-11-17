'use strict';
// A per-session module's partitions over the session's life (shared runtime
// R1 Task 6; #236 section 4a and section 6). Main thread only; wired by
// lib/route-manager.js startSessions.
//
// - A session that ends: its workers stop (lib/session-workers.js), and
//   only once every one has exited, its partition of each per-session
//   module is removed (lib/session-partition.js): its store keys under
//   ms:<name>:<id>: and its files under <name>/sessions/<id>/. Removed when
//   the session left ('bye') or its reconnect window passed ('window');
//   never when the runtime stops ('closed'), since the next start may
//   restore it. A call it had in flight ends with the worker, as an unload's
//   does. Nothing here is ever fatal: a partition that can't be removed is
//   logged, and the next start's sweep tries again.
// - A start: after the daemon's table is restored and before the listener
//   accepts, every partition of a session not restored is removed (the
//   sweep). One that can't be removed is logged, never fatal: no one
//   session's files can stop the runtime from starting.
// - D3 (#349): when the sweep removed something and nothing was restored
//   (the daemon died, so no table came back), the next session to open is
//   told, once, that per-session state was reset.
// No session id is written to a log line here: a module's name and the
// reason only.
const LOG = require('./logger');
const options = require('./cli-options');
const partition = require('./session-partition');
const {isRecord} = require('./session-module-record');

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

// every per-session module loaded now (its listing record)
function perSessionNames(mm) {
  const modules = (mm != null && mm.modules != null) ? mm.modules : {};
  return Object.keys(modules).filter((name) => isRecord(modules[name]));
}

// The registry's 'gone' (id, reason). -> Promise, never rejected.
async function ended(mm, id, reason, env) {
  if (mm == null || mm.sessionWorkers == null) return;
  // the workers first: a partition is never removed under one still running
  try {
    await mm.sessionWorkers.stopSession(id);
  } catch (e) {
    LOG.E(new Error(`a session's per-session workers did not all stop (${e.message}); its partitions are kept for the next start's sweep`));
    return;
  }
  if (reason !== 'bye' && reason !== 'window') return;
  for (const name of perSessionNames(mm)) {
    try {
      await partition.remove(rootOf(env), kvOf(env), name, id);
    } catch (e) {
      LOG.E(new Error(`module: ${name}: a session's partition was not removed (${String(e.code || e.message).slice(0, 200)}); the next start's sweep tries again`));
    }
  }
}

// After the restore, before the listener. -> Promise of the sweep's
// {removed, failed, skipped} counts, never rejected.
// It removes every partition in the store whose session wasn't restored, so
// the store must be this runtime's alone: framework.js refuses
// --sessionSocket unless --store local (pinned by session-runtime 01). Relax
// one only with the other.
async function sweepAtStart(restoredIds, env) {
  const keep = new Set(restoredIds);
  let result = null;
  try {
    result = await partition.sweep(rootOf(env), kvOf(env), keep);
  } catch (e) {
    LOG.E(new Error(`per-session state: the start's sweep did not run (${String(e.message).slice(0, 200)}); serving anyway`));
    return {removed: 0, failed: 0, skipped: 0};
  }
  for (const f of result.failed) LOG.E(new Error(`module: ${f.name}: a partition of a session not restored was not removed (${f.why}); serving anyway`));
  for (const s of result.skipped) LOG.E(new Error(`per-session state: ${s.path} is ${s.why === 'a link' ? 'a link' : 'not a directory'}, so nothing under it is swept; remove or replace it`));
  if (result.removed.length > 0) LOG.I(`per-session state: ${result.removed.length} partition(s) of sessions not restored removed`);
  if (result.removed.length > 0 && keep.size === 0) resetPending = true;
  return {removed: result.removed.length, failed: result.failed.length, skipped: result.skipped.length};
}

// The registry's 'session': the first one after a start that reset
// per-session state is told so, once, on its first result.
function sessionOpened(id) {
  if (!resetPending) return;
  resetPending = false;
  require('./notices').add(null, RESET_AT_START, {session: id, sessionOnly: true});
}

module.exports = {ended, sweepAtStart, sessionOpened, RESET_AT_START, RESET_AT_START_TEXT, resetForTests: () => { resetPending = false; }};
