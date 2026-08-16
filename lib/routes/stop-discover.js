const express = require('express');

//FIXME: when we specify appKey this call will return unknown device
module.exports = function(mm, cdifInterface) {
  const router = express.Router();
  router.route('/').post((req, res) => {
    const session = req.session;
    cdifInterface.stopDiscoverAll(session);
  });
  return router;
}
