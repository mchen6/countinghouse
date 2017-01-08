var options       = require('../cli-options');
var Session       = require('../session');

var nano          = require('nano')(options.dbUrl);

var usersDB = nano.db.use('_users');

var validateUser = function(req, res, next) {
  if (options.isDebug === true) {
    var session = new Session(req, res, 'debug', 'debug', 0, req.params.deviceID, null);
    req.session = session;
    return next();
  }

  var appkey = req.get('X-Apemesh-Key');

  if (usersDB == null) {
    return res.status(500).json({topic: 'cdif error', message: '用户数据库不可用'});
  }
  if (appkey == null) {
    return res.status(500).json({topic: 'cdif error', message: '用户appKey非法'});
  }

  var deviceID = req.params.deviceID;

  usersDB.view('user', 'byAppKeyWithBasicInfo', { key: appkey }, function(err, doc) {
    if (err) {
      return res.status(500).json({topic: 'cdif error', message: err.message});
    }
    if (doc.rows.length > 0) {
      // here we create a new session obj on each request
      // better if we can reuse it, after a existing session obj (which is indexed by appkey) completes a request
      var username     = doc.rows[0].value[0];
      var balance      = doc.rows[0].value[1];
      var devices      = doc.rows[0].value[2];
      var freeAPICount = null;

      var hasDevice = false;
      if (devices != null && typeof(devices === 'array')) {
        devices.forEach(function(item) {
          if (item.deviceID === deviceID) {
            freeAPICount = item.freeAPICount;
            hasDevice = true;
          }
        });
      }

      if (hasDevice === false) {
        return res.status(500).json({topic: 'cdif error', message: '设备不在用户设备列表中，请从API市场添加'});
      }

      if (typeof(balance) !== 'number') {
        return res.status(500).json({topic: 'cdif error', message: '用户余额数据格式非法'});
      }

      var session = new Session(req, res, username, appkey, balance, deviceID, freeAPICount);
      req.session = session;
      next();
    } else {
      res.status(500).json({topic: 'cdif error', message: '未知用户: ' + appkey});
    }
  });
}

module.exports = validateUser;
