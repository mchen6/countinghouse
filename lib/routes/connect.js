const express = require('express');

module.exports = function(mm, cdifInterface) {
  const router = express.Router({mergeParams: true});

  router.route('/').post((req, res) => {
    const session = req.session;

    const deviceID = req.params.deviceID;
    let user     = req.body.username;
    let pass     = req.body.password;

    if (user == null && pass == null) {
      user = ''; pass = '';
    } else if (user == null || user === '') {
      return session.callbackWithoutTimer(new CHError('USERNAME_INVALID'));
    } else if (pass == null || pass === '') {
      return session.callbackWithoutTimer(new CHError('PASSWORD_INVALID'));
    }
    cdifInterface.connectDevice(deviceID, user, pass, session);
  });
  return router;
}
