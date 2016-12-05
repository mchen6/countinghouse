var options       = require('../cli-options');
var Session       = require('../session');
var CdifError     = require('../error').CdifError;
var DeviceError   = require('../error').DeviceError;

var nano          = require('nano')(options.dbUrl);

var users   = {};
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

  // find appkey from memory cache, if not found then find from couch, if found then cache it's appkey in memory, if not return fail
  if (users[appkey] == null) {
    usersDB.view('user', 'byAppKey', { key: appkey }, function(err, doc) {
      if (err) {
        return res.status(500).json({topic: new CdifError().topic, message: err.message});
      }
      if (doc.rows.length > 0) {
        // here we create a new session obj on each request
        // better if we can reuse it, after a existing session obj (which is indexed by appkey) completes a request
        var username = doc.rows[0].id;
        var session = new Session(req, res, username);
        req.session = session;
        users[appkey] = username;
        next();
      } else {
        res.status(500).json({topic: new CdifError().topic, message: 'user not found'});
      }
    });
  } else {
    var session = new Session(req, res, users[appkey]);
    req.session = session;
    next();
  }
}

module.exports = validateUser;
