'use strict';
const express   = require('express');
const CountinghouseError = require('../countinghouse-error').CountinghouseError;
const clientText = require('../client-text');
const verdict = require('../hidden-text-verdict');

module.exports = function(mm, cdifInterface) {
  const router = express.Router({mergeParams: true});

  router.route('/*').get((req, res) => {
    const session  = req.session;
    const deviceID = req.params.deviceID;
    const path     = req.path;

    // An action its declared text leaves unusable: its own input or output
    // schema, or anything under it, is refused (the load's decision, as
    // get-spec leaves the action out; the reviewer's ruling on #400)
    if (verdict.pointerUnusable(deviceID, path)) return session.callbackWithoutTimer(new CountinghouseError('MODULE_NOT_LISTED', deviceID));
    // And what is answered is judged as tools/list judges a schema: it is
    // dereferenced, so whatever path reaches a node (a parent, a shared $ref
    // target, another spelling), this sees it. A schema (a plain object)
    // that holds a hidden character where nothing can be left out is
    // refused, any other sent cleaned; any other value (a string, a number,
    // a list) is refused if it holds a hidden character anywhere.
    const answer = session.callback;
    session.callback = function(err, data, ...rest) {
      if (err != null) return answer.call(this, err, data, ...rest);
      const refused = () => answer.call(this, new CountinghouseError('MODULE_NOT_LISTED', deviceID), null, ...rest);
      if (data != null && typeof(data) === 'object' && !Array.isArray(data)) {
        const judged = clientText.schema(data);
        return judged.unusable ? refused() : answer.call(this, null, judged.schema, ...rest);
      }
      return clientText.holdsHidden(data) ? refused() : answer.call(this, null, data, ...rest);
    };
    cdifInterface.getDeviceSchema(deviceID, path, session);
  });
  return router;
}

