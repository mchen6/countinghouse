'use strict';
// A shared runtime's open subscriptions/listen streams, per session (after
// #238; the review of #249). A listen's stream is its session's own
// connection: its notifications go as headerless M frames (s.notify), and it
// ends with the session's detach or end, or a notifications/cancelled naming
// it. Its client re-issues on reconnect, as the spec has it.
//
// - A stream opened for a session that has already gone (it detached or
//   ended while the listen's key was being checked, which is asynchronous)
//   is closed at once and never kept, so it holds no slot and sends nothing.
// - A second listen with an id the session already has open is a duplicate
//   (the caller refuses it), so the first one's cancel is never overwritten.
// - Ids compare as JSON values: "7" is not 7.
const key = (id) => JSON.stringify(id);

// registry: the session registry ('session' events, get(id));
// closeSession(id): the hub's drop of that session's listeners
function createSessionListens({registry, closeSession}) {
  const listens = new Map();   // session id -> Map(id key -> cancel)
  const drop = (sid) => {
    const mine = listens.get(sid);
    listens.delete(sid);
    if (mine != null) for (const cancel of mine.values()) cancel();
    closeSession(sid);
  };
  registry.on('session', (s) => {
    s.on('detach', () => drop(s.id));
    s.on('end', () => drop(s.id));
  });
  const gone = (s) => s.connected !== true || registry.get(s.id) == null;

  return {
    duplicate: (s, message) => {
      const mine = listens.get(s.id);
      return mine != null && mine.has(key(message.id));
    },
    cancel: (s, requestId) => {
      const mine = listens.get(s.id);
      const k = key(requestId);
      const cancel = mine != null ? mine.get(k) : null;
      if (cancel == null) return false;
      mine.delete(k);
      cancel();
      return true;
    },
    // the gateway's openStream for this session's listen request
    // release(): the listen ended itself (its tasks done, its key revoked):
    // its id is let go, so it can be opened again, and only its own entry, never
    // one opened since under that id (the final pass's gateway part, A13)
    streamFor: (s, message) => {
      const k = key(message.id);
      let entry = null;
      return {
        write: (m) => s.notify(m),
        onClose: (fn) => {
          if (gone(s)) { setImmediate(fn); return; }
          if (!listens.has(s.id)) listens.set(s.id, new Map());
          entry = () => { const mine = listens.get(s.id); if (mine != null) mine.delete(k); fn(); };
          listens.get(s.id).set(k, entry);
        },
        release: () => {
          const mine = listens.get(s.id);
          if (entry != null && mine != null && mine.get(k) === entry) mine.delete(k);
          entry = null;
        }
      };
    },
    count: (sid) => (listens.has(sid) ? listens.get(sid).size : 0)
  };
}

module.exports = {createSessionListens};
