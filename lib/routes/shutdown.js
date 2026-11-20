'use strict';
const express = require('express');
const Session = require('../session');

// subscriptions: the subscriptions/listen hub (#231), whose streams end
// gracefully before the exit, so each client gets its result rather than a
// dropped stream
module.exports = function(subscriptions) {
  const router = express.Router();

  router.route('/').post((req, res) => {
    if (subscriptions != null) subscriptions.endAll();
    // the graceful ends are written before the process goes
    setTimeout(() => process.exit(0), 100);
  });
  return router;
}
