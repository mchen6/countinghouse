'use strict';
// The startup list's modules load several at once under --workerThread
// (lib/module-manager.js loadAllModules; the startup levers' (2)), but each
// one's devices are handed on to registration (onModuleLoad's
// 'registerdevices') in the list's order, so every reader of the device map
// sees the order a one-at-a-time start gave:
// tools/list and its deduped names, prompts, resources, a deviceID's first
// holder. Main thread only.
//
// inTurn(name, fn): fn(true) runs once every module before `name` in the
// list has been handed on, or has finished without being handed on (a load
// that failed: finished(name)). A second inTurn for a name still waiting (a
// restart before its turn) replaces the first. A name not in the list, or one
// whose turn has passed (a supervised restart, a later load in place), runs
// at once: fn().
// finished(name) is called for every load when it answers, so no turn waits
// on a load that never hands on: the order can never hold a start up.

function StartupOrder(names) {
  this.names = names.slice();
  this.next = 0;
  this.waiting = new Map();   // name -> fn, handed on at its turn
  this.ended = new Set();     // answered; passes its turn if nothing waits
}

StartupOrder.prototype.indexOf = function(name) {
  const i = this.names.indexOf(name);
  return (i === -1 || i < this.next) ? -1 : i;
};

StartupOrder.prototype.inTurn = function(name, fn) {
  if (this.indexOf(name) === -1) return fn();
  this.waiting.set(name, fn);
  this.advance();
};

StartupOrder.prototype.finished = function(name) {
  if (this.indexOf(name) === -1) return;
  this.ended.add(name);
  this.advance();
};

StartupOrder.prototype.advance = function() {
  while (this.next < this.names.length) {
    const name = this.names[this.next];
    const fn = this.waiting.get(name);
    if (fn == null && !this.ended.has(name)) return;
    this.waiting.delete(name);
    this.ended.delete(name);
    this.next += 1;
    if (fn != null) fn(true);
  }
};

StartupOrder.prototype.done = function() { return this.next >= this.names.length; };

module.exports = {StartupOrder};
