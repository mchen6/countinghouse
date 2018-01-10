var options       = require('../cli-options');
var Session       = require('../session');
var express       = require('express');
var nano          = require('nano')(options.dbUrl);

var usersDB   = nano.db.use('_users');
var devicesDB = nano.db.use('devices');

module.exports = function(mm, cdifInterface) {
  var router = express.Router();

  router.route('/').get(function(req, res) {
    // in debug mode return the list of all managed devices
    // in non-debug mode return user's device list in couchDB
    if (options.isDebug === true) {
      var session = new Session(req, res, 'unknown', 'device-list', 0, null, null, null);
      return cdifInterface.getDiscoveredDeviceList(session);
    }

    var appkey = req.get('X-Apemesh-Key');

    if (appkey == null) {
      return res.status(500).json({topic: 'cdif error', message: '用户appKey非法'});
    }

    if (usersDB == null) {
      return res.status(500).json({topic: 'cdif error', message: '用户数据库不可用'});
    }

    if (devicesDB == null) {
      return res.status(500).json({topic: 'cdif error', message: '设备数据库不可用'});
    }

    usersDB.view('user', 'byAppKey', { key: appkey }, function(err, doc) {
      if (err) {
        return res.status(500).json({topic: 'cdif error', message: err.message});
      }
      if (doc.rows.length > 0) {
        var devices = doc.rows[0].value.devices;

        var deviceList = [];
        var queryKey   = [];

        devices.forEach(function(item) {
          queryKey.push(item.deviceID);
        });
        devicesDB.view('devices', 'byDeviceIdWithSpec', {keys: queryKey}, function(err, doc) {
          if (err) {
            return res.status(500).json({topic: 'cdif error', message: err.message});
          }
          doc.rows.forEach(function(item) {
            deviceList.push(item.value);
          });
          res.status(200).json(deviceList);
        });
      } else {
        res.status(500).json({topic: 'cdif error', message: '未知用户: ' + appkey});
      }
    });

  });
  return router;
}
