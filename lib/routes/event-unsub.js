var express   = require('express');

module.exports = function(mm, cdifInterface) {
  var router = express.Router({mergeParams: true});

  router.route('/').post(function(req, res) {
    var session   = req.session;
    var deviceID  = req.params.deviceID;
    var serviceID = req.body.serviceID;
    var token     = req.body.device_access_token;

    // test subscriber
    var subscriber = new function() {
      this.publish = function(updated, data) {
        console.log(data);
      };
    };
    cdifInterface.eventUnsubscribe(subscriber, deviceID, serviceID, token, session);
  });
  return router;
}
