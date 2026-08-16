const express   = require('express');
const Session   = require('../session');

module.exports = function(mm, cdifInterface) {
  const router = express.Router({mergeParams: true});

  router.route('/').get((req, res) => {
    const session = new Session(req, res, 'unknown', 'load_profile', 0, null, null, null);

    let interval = 60 * 1000;
    if (req.body && req.body.interval) {
      interval = req.body.interval;
    }

    cdifInterface.getServerLoadLevel(interval, session.callbackWithoutTimer.bind(session));
  });
  return router;
}
