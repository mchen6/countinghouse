var options       = require('./cli-options');
var Session       = require('./session');
var LOG           = require('./logger');
var CdifError     = require('./cdif-error').CdifError;
var nano          = require('nano')(options.dbUrl);
var redis         = require("redis");
var redisClient   = redis.createClient(options.redisUrl);

redisClient.on('error', function (err) {
  if (options.debug !== true) LOG.E(new CdifError('REDIS_CLIENT_ERROR', err.message));
});

var usersDB = nano.db.use('_users');

// req & res can be null is this is from a local service client call
// serviceID and actionName can be null if this is applied on reverse-proxy route
var doUserAuth = function(req, res, deviceID, appKey, serviceID, actionName, localCB, callback) {
  if (options.debug === true) {
    // quick path in case we are running in container
    if (options.debugKey == null) {
      var session = new Session(req, res, 'debug', appKey, 0, deviceID, 0, localCB);
      return callback(null, session);
    }

    var debugKey = options.debugKey;
    if (appKey == null || appKey !== debugKey) {
      return callback(new CdifError('SYSTEM_ERROR_UNKNOWN_USER'));
    }
    var session = new Session(req, res, 'debug', appKey, 0, deviceID, 0, localCB);
    return callback(null, session);
  }

  if (appKey == null) {
    return callback(new CdifError('SYSTEM_ERROR_UNKNOWN_USER'));
  }

  if (usersDB == null) {
    return callback(new CdifError('SYSTEM_ERROR_USERDB_NA'));
  }

  redisClient.hmget(appKey, 'userName', 'balance', 'devices', function(err, results) {
    if (err) {
      return callback(new CdifError('REDIS_CLIENT_ERROR'));
    }
    if (results[0] == null) { // key not exists in redis, turn to couch
      usersDB.view('user', 'byAppKeyWithBasicInfo', { key: appKey }, function(err, doc) {
        if (err) {
          return callback(new CdifError('SYSTEM_ERROR_USERDB_NA', err.message));
        }
        if (doc.rows.length > 0) {
          // here we create a new session obj on each request
          // better if we can reuse it, after a existing session obj (which is indexed by appKey) completes a request
          var userName     = doc.rows[0].value[0];
          var balance      = doc.rows[0].value[1];
          var devices      = doc.rows[0].value[2];

          var priceRecord  = null;
          var hasDevice = false;
          if (devices != null && Array.isArray(devices)) {
            for (var i = 0; i < devices.length; i++) {
              if(devices[i].deviceID === deviceID) {
                hasDevice = true;
                priceRecord = devices[i].priceRecord;
                break;
              }
            }
          }

          if (hasDevice === false)          return callback(new CdifError('USER_HAS_NO_DEVICE'));
          if (typeof(balance) !== 'number') return callback(new CdifError('INVALID_BALANCE_FORMAT')); // balance format is invalid in user's record
          if (priceRecord == null)          return callback(new CdifError('NO_PRICE_RECORD')); //there is no priceRecord field in user's device list

          //TODO: on website delete a key when user add a new device, so we can invalidate the cache to find this new device
          redisClient.hmset(appKey, 'userName', userName, 'balance', balance, 'devices', JSON.stringify(devices)); //first cache basic info

          var apiRemainCount = 0;
          var session = new Session(req, res, userName, appKey, balance, deviceID, apiRemainCount, localCB);

          session.serviceID   = serviceID;
          session.actionName  = actionName;
          session.userDevices = devices;

          if (serviceID != null && actionName != null && priceRecord[serviceID] != null && priceRecord[serviceID][actionName] != null) {
            session.apiRemainCount = priceRecord[serviceID][actionName].count;
          }
          return callback(null, session);
        }
        return callback(new CdifError('SYSTEM_ERROR_UNKNOWN_USER', appKey));
      });
    } else {
      //user key found in redis
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
          return callback(new CdifError('USER_DEVICE_RECORD_FORMAT_INVALID', e.message));
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
      var session = new Session(req, res, userName, appKey, balance, deviceID, apiRemainCount, localCB);

      session.serviceID   = serviceID;
      session.actionName  = actionName;
      session.userDevices = devices;

      if (serviceID != null && actionName != null && priceRecord != null && priceRecord[serviceID] != null && priceRecord[serviceID][actionName] != null) {
         // free apis may have zero count, service code won't deny the action call if realPrice <= 0
        session.apiRemainCount = priceRecord[serviceID][actionName].count;
      }

      if (hasDevice === true) {
        return callback(null, session);
      }
      // check couch again to find out user's newly added devices
      usersDB.view('user', 'byAppKeyWithBasicInfo', { key: appKey }, function(err, doc) {
        if (err) {
          return callback(new CdifError('SYSTEM_ERROR_USERDB_NA', err.message));
        }
        if (doc.rows.length > 0) {
          var devices   = doc.rows[0].value[2];
          var hasDevice = false;

          if (devices != null && Array.isArray(devices)) {
            for (var i = 0; i < devices.length; i++) {
              if(devices[i].deviceID === deviceID) {
                hasDevice = true;
                priceRecord = devices[i].priceRecord;
                break;
              }
            }
          }
          if (hasDevice === false) return callback(new CdifError('USER_HAS_NO_DEVICE'));

          redisClient.hmset(appKey, 'devices', JSON.stringify(devices));

          session.serviceID   = serviceID;
          session.actionName  = actionName;
          session.userDevices = devices;

          if (serviceID != null && actionName != null && priceRecord != null && priceRecord[serviceID] != null && priceRecord[serviceID][actionName] != null) {
            session.apiRemainCount = priceRecord[serviceID][actionName].count;
          }
          return callback(null, session);
        }
        redisClient.del(appKey); // delete this key if it is not found in couch
        return callback(new CdifError('SYSTEM_ERROR_UNKNOWN_USER', appKey));
      });
    }
  });
}

module.exports = doUserAuth;
