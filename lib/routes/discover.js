var express = require('express');

//FIXME: when we specify appKey this call will return unknown device
module.exports = function(mm, cdifInterface) {
  var router = express.Router();

  router.route('/').post(function(req, res) {
    var session = req.session;
    cdifInterface.discoverAll(session);
  });
  return router;
}
