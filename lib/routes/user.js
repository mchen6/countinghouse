var options       = require('../cli-options');
var Session       = require('../session');
var CdifError     = require('../error').CdifError;
var DeviceError   = require('../error').DeviceError;

var nano          = require('nano')(options.dbUrl);

var usersDB = nano.db.use('_users');

var validateUser = function(req, res, next) {
  if (options.isDebug === true) {
    var session = new Session(req, res, 'debug');
    req.session = session;
    return next();
  }

  var appkey = req.get('X-Apemesh-Key');

  if (usersDB == null) {
    return res.status(500).json({topic: new CdifError().topic, message: 'user db not available'});
  }
  if (appkey == null) {
    return res.status(500).json({topic: new CdifError().topic, message: 'invalid app key'});
  }

  var deviceID = req.params.deviceID;

  usersDB.view('user', 'byAppKey', { key: appkey }, function(err, doc) {
    if (err) {
      return res.status(500).json({topic: new CdifError().topic, message: err.message});
    }
    if (doc.rows.length > 0) {
      // here we create a new session obj on each request
      // better if we can reuse it, after a existing session obj (which is indexed by appkey) completes a request
      var username = doc.rows[0].id;
      var balance  = doc.rows[0].value.balance;
      var devices = doc.rows[0].value.devices;

      var hasDevice = false;
      devices.forEach(function(item) {
        if (item.deviceID === deviceID) hasDevice = true;
      });

      if (hasDevice === false) {
        return res.status(500).json({topic: new CdifError().topic, message: 'device not available to user'});
      }

      if (typeof(balance) !== 'number') {
        return res.status(500).json({topic: new CdifError().topic, message: 'user balance data malformed'});
      }
      var session = new Session(req, res, username, appkey, balance);
      req.session = session;
      next();
    } else {
      res.status(500).json({topic: new CdifError().topic, message: 'user not found'});
    }
  });
}

module.exports = validateUser;
