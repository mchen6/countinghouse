var options       = require('../cli-options');
var Session       = require('../session');

var nano          = require('nano')(options.dbUrl);
var redis         = require("redis");
var redisClient   = redis.createClient(options.redisUrl);

redisClient.on('error', function (err) {
  LOG.E(new CdifError('REDIS_CLIENT_ERROR', err.message));
});

var usersDB = nano.db.use('_users');

var validateUser = function(req, res, next) {
  if (options.isDebug === true) {
    var session = new Session(req, res, 'debug', 'debug', 0, req.params.deviceID, null);
    req.session = session;
    return next();
  }

  var appKey = req.get('X-Apemesh-Key');

  if (usersDB == null) {
    return res.status(500).json({topic: 'cdif error', message: '用户数据库不可用'});
  }
  if (appKey == null) {
    return res.status(500).json({topic: 'cdif error', message: '用户appKey非法'});
  }

  var deviceID = req.params.deviceID;

  redisClient.hmget(appKey, 'userName', 'balance', 'devices', function(err, results) {
    if (err) {
      return res.status(500).json({topic: 'cdif error', message: 'redis客户端错误'});
    }
    if (results[0] == null) { // key not exists
      usersDB.view('user', 'byAppKeyWithBasicInfo', { key: appKey }, function(err, doc) {
        if (err) {
          return res.status(500).json({topic: 'cdif error', message: err.message});
        }
        if (doc.rows.length > 0) {
          // here we create a new session obj on each request
          // better if we can reuse it, after a existing session obj (which is indexed by appKey) completes a request
          var userName     = doc.rows[0].value[0];
          var balance      = doc.rows[0].value[1];
          var devices      = doc.rows[0].value[2];

          var priceRecord  = null;
          var hasDevice = false;
          if (devices != null && typeof(devices === 'array')) {
            for (var i = 0; i < devices.length; i++) {
              if(devices[i].deviceID === deviceID) {
                hasDevice = true;
                priceRecord = devices[i].priceRecord;
                break;
              }
            }
          }

          if (hasDevice === false)          return res.status(500).json({topic: 'cdif error', message: '设备不在用户设备列表中，请从API市场添加'});
          if (typeof(balance) !== 'number') return res.status(500).json({topic: 'cdif error', message: '用户余额数据格式非法'});
          if (priceRecord == null)          return res.status(500).json({topic: 'cdif error', message: '用户api计数格式非法'});

          //TODO: on website delete a key when user add a new device, so we can invalidate the cache to find this new device
          redisClient.hmset(appKey, 'userName', userName, 'balance', balance, 'devices', JSON.stringify(devices)); //first cache basic info

          var apiRemainCount = 0;
          var session = new Session(req, res, userName, appKey, balance, deviceID, apiRemainCount);

          var serviceID = req.body.serviceID; var actionName = req.body.actionName;
          if (serviceID != null && typeof(serviceID) === 'string' && actionName != null && typeof(actionName) === 'string') {
            session.serviceID   = req.body.serviceID;
            session.actionName  = req.body.actionName;
            session.userDevices = devices;

            if (priceRecord[serviceID] != null && priceRecord[serviceID][actionName] != null) {
              session.apiRemainCount = priceRecord[serviceID][actionName].count;
            }
          }
          req.session = session;
          return next();
        }
        return res.status(500).json({topic: 'cdif error', message: '未知用户: ' + appKey});
      });
    } else {
      //TODO: here we assume user won't delete a device and won't change appKey,
      //if in such case, we need to delete the key from website and rebuild it
      var userName = results[0];
      var balance  = 0;

      if (results[1] != null) {
        balance = +results[1];
      }

      var priceRecord = null;
      var hasDevice   = false;

      if (results[2] != null) {
        var devices = null;
        try {
          devices = JSON.parse(results[2]);
        } catch (e) {
          return res.status(500).json({topic: 'cdif error', message: '用户设备列表格式非法: ' + e.message});
        }

        for (var i = 0; i < devices.length; i++) {
          if(devices[i].deviceID === deviceID) {
            hasDevice = true;
            priceRecord = devices[i].priceRecord;
            break;
          }
        }
      }

      var apiRemainCount = 0;
      var session = new Session(req, res, userName, appKey, balance, deviceID, apiRemainCount);

      var serviceID = req.body.serviceID; var actionName = req.body.actionName;
      if (serviceID != null && typeof(serviceID) === 'string' && actionName != null && typeof(actionName) === 'string') {
        session.serviceID   = req.body.serviceID;
        session.actionName  = req.body.actionName;
        session.userDevices = devices;

        if (priceRecord != null && priceRecord[serviceID] != null && priceRecord[serviceID][actionName] != null) {
           // free apis may have zero count, service code won't deny the action call if realPrice <= 0
          session.apiRemainCount = priceRecord[serviceID][actionName].count;
        }
      }
      req.session = session;

      if (hasDevice === true) {
        return next();
      }
      // check couch again to find out user's newly added devices
      usersDB.view('user', 'byAppKeyWithBasicInfo', { key: appKey }, function(err, doc) {
        if (err) {
          return res.status(500).json({topic: 'cdif error', message: err.message});
        }
        if (doc.rows.length > 0) {
          var devices   = doc.rows[0].value[2];
          var hasDevice = false;

          if (devices != null && typeof(devices === 'array')) {
            for (var i = 0; i < devices.length; i++) {
              if(devices[i].deviceID === deviceID) {
                hasDevice = true;
                priceRecord = devices[i].priceRecord;
                break;
              }
            }
          }
          if (hasDevice === false) return res.status(500).json({topic: 'cdif error', message: '设备不在用户设备列表中，请从API市场添加'});

          redisClient.hmset(appKey, 'devices', JSON.stringify(devices));

          var serviceID = req.body.serviceID; var actionName = req.body.actionName;
          if (serviceID != null && typeof(serviceID) === 'string' && actionName != null && typeof(actionName) === 'string') {
            session.serviceID   = req.body.serviceID;
            session.actionName  = req.body.actionName;
            session.userDevices = devices;

            if (priceRecord != null && priceRecord[serviceID] != null && priceRecord[serviceID][actionName] != null) {
              session.apiRemainCount = priceRecord[serviceID][actionName].count;
            }
          }
          return next();
        }
        redisClient.del(appKey); // delete this key if it is not found in couch
        return res.status(500).json({topic: 'cdif error', message: '未知用户: ' + appKey});
      });
    }
  });
}

module.exports = validateUser;
