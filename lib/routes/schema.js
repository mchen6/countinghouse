'use strict';
const express   = require('express');
const CountinghouseError = require('../countinghouse-error').CountinghouseError;
const verdict = require('../hidden-text-verdict');
const schemaAnswer = require('../schema-answer');
const {declaredTokens} = require('../schema-safety');

module.exports = function(mm, cdifInterface) {
  const router = express.Router({mergeParams: true});

  router.route('/*').get((req, res) => {
    const session  = req.session;
    const deviceID = req.params.deviceID;
    const path     = req.path;

    // The path's tokens, as the load reads a declared pointer ('/' the
    // document; lib/schema-safety.js)
    const tokens = declaredTokens(path);
    if (tokens == null) return session.callbackWithoutTimer(new CountinghouseError('INVALID_JSON_POINTER', path));
    // Only what tools/list advertises is answered (#400's high review, the
    // reviewer's ruling; lib/schema-answer.js): a usable action's declared
    // schemas as tools/list shows them, at or under the path, or a
    // container of them above it; an unusable action's are refused; any
    // other path names nothing. The device's schema.json is read whole (the
    // lookup of '/': the raw document, the main thread's copy in worker
    // mode) and the answer made from it.
    // (the spec and document as the request began: one that a reload
    // replaced meanwhile is refused, never paired with the other's)
    const partsNow = () => (cdifInterface.deviceManager != null ? cdifInterface.deviceManager.schemaPartsOf(deviceID) : {spec: null, schemaDoc: null});
    const began = partsNow();
    const answer = session.callback;
    session.callback = function(err, data, ...rest) {
      if (err != null) return answer.call(this, err, data, ...rest);
      const held = partsNow();
      if (held.spec == null || data == null || typeof(data) !== 'object' || held.spec !== began.spec || held.schemaDoc !== data) {
        return answer.call(this, new CountinghouseError('MODULE_NOT_LISTED', deviceID), null, ...rest);
      }
      const made = schemaAnswer.answer(data, held.spec, tokens, (serviceID, actionName) => verdict.unusableAt(deviceID, serviceID, actionName));
      if (made.refused != null) return answer.call(this, new CountinghouseError(made.refused, made.refused === 'MODULE_NOT_LISTED' ? deviceID : path), null, ...rest);
      return answer.call(this, null, made.value, ...rest);
    };
    cdifInterface.getDeviceSchema(deviceID, '/', session);
  });
  return router;
};
