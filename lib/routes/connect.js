var express = require('express');

module.exports = function(mm, cdifInterface) {
  var router = express.Router({mergeParams: true});

  router.route('/').post(function(req, res) {
    var session = req.session;

    var deviceID = req.params.deviceID;
    var user     = req.body.username;
    var pass     = req.body.password;

    if (user == null && pass == null) {
      user = ''; pass = '';
    } else if (user == null || user === '') {
      return session.callbackWithoutTimer(new CdifError('USERNAME_INVALID'));
    } else if (pass == null || pass === '') {
      return session.callbackWithoutTimer(new CdifError('PASSWORD_INVALID'));
    }
    cdifInterface.connectDevice(deviceID, user, pass, session);
  });
  return router;
}
