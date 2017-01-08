var options       = require('../cli-options');

var nano          = require('nano')(options.dbUrl);

var usersDB   = nano.db.use('_users');
var devicesDB = nano.db.use('devices');

var getUserDeviceList = function(req, res) {
  if (options.isDebug === true) {
    return res.status(500).json({topic: 'cdif error', message: 'debug mode, no user specified'});
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
        var keyItem = [];
        keyItem.push(item.deviceID);
        keyItem.push(item.version);
        queryKey.push(keyItem);
      });

      devicesDB.view('devices', 'byDeviceIdAndVersionWithSpec', {keys: queryKey}, function(err, doc) {
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
}

module.exports = getUserDeviceList;
