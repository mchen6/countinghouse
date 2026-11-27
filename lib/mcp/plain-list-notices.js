'use strict';
// A legacy (2025-11-25) stdio client's prompts and resources lists, told
// when they change (R-cold-prompts: a cold start's client lists its prompts
// before the packs have loaded). lib/route-manager.js's stdio path drives it;
// its tools are compared there, as before.
//
// Each list is its own: prompts/list, resources/list and
// resources/templates/list. Once the client has asked for one, what it was
// shown is that whole list's fingerprint as it was when it asked (list(),
// subscriptions.js's per-item hashes, never the list), re-baselined only by
// its own method. After the changes settle, each list it asked for is listed
// again, and one that differs sends its kind's notice: the resources and
// their templates share notifications/resources/list_changed, sent once a
// round.
//
// - A change after its first page was asked for, before its whole list was
//   taken, makes it stale (the next comparison tells it), as does a list that
//   could not be taken, or an error answer: the client asked.
// - A comparison that comes back while the client is listing that list again
//   says nothing: the client's own take is newer, and decides.
// - reset(): the client went on in 2026-07-28 (which tells nothing unasked);
//   nothing it listed is followed until it asks again.
const STALE = '';
const NOTICES = {
  'prompts/list': 'notifications/prompts/list_changed',
  'resources/list': 'notifications/resources/list_changed',
  'resources/templates/list': 'notifications/resources/list_changed'
};

// list(method, cb): cb(the whole list's fingerprint, or null); notify(method)
function createPlainListNotices({list, notify, settleMs = 250}) {
  const followed = new Map();   // method -> {shown, taking}
  for (const method of Object.keys(NOTICES)) followed.set(method, {shown: null, taking: 0});
  let changes = 0;
  let timer = null;

  const compareSoon = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const due = new Set();
      const round = [...followed].filter(([, st]) => st.shown != null && st.taking === 0);
      let left = round.length;
      for (const [method, st] of round) {
        list(method, (now) => {
          if (now != null && now !== st.shown && st.taking === 0) {
            st.shown = now;
            due.add(NOTICES[method]);
          }
          left -= 1;
          if (left === 0) for (const notice of due) notify(notice);
        });
      }
    }, settleMs);
    if (typeof(timer.unref) === 'function') timer.unref();
  };

  return {
    // a request for its first page, as it begins: a token, or null for a
    // method this does not follow
    began(method) {
      return followed.has(method) ? {method, at: changes} : null;
    },
    // that request answered (ok: with a result): its whole list taken
    answered(token, ok) {
      if (token == null) return;
      const st = followed.get(token.method);
      if (!ok) { st.shown = STALE; return; }
      st.taking += 1;
      list(token.method, (print) => {
        st.taking -= 1;
        st.shown = (print == null || changes !== token.at) ? STALE : print;
        if (st.shown === STALE) compareSoon();
      });
    },
    // the device manager's toolschanged (a list being taken compares once
    // it is: a change since its request began makes it stale)
    changed() {
      changes += 1;
      if ([...followed.values()].some((st) => st.shown != null && st.taking === 0)) compareSoon();
    },
    reset() {
      for (const st of followed.values()) st.shown = null;
    },
    stop() {
      clearTimeout(timer);
      timer = null;
    }
  };
}

module.exports = {createPlainListNotices};
