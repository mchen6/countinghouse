//get resource tree and count the devices under each folder
//usage: node ./count.js --host http://47.97.60.12:9527 --appKey ***REDACTED-APPKEY***

var argv = require('minimist')(process.argv.slice(1));
var request = require('request');
var async   = require('async');
 
var opts = {
  url: argv.host + '/devices/dd2a9a6f-e9d6-5bff-875f-d9283124909f/invoke-action',
  method: 'POST',
  headers: {
    'X-Apemesh-Key': argv.appKey,
  },
  json: {
    "serviceID": "urn:apemesh-com:serviceID:ApiStatService",
    "actionName": "getResourceTree",
    "input": {}
  }
};

function getItemName(deviceID, callback) {
  var option = {
    url: argv.host + '/devices/dd2a9a6f-e9d6-5bff-875f-d9283124909f/invoke-action',
    method: 'POST',
    headers: {
      'X-Apemesh-Key': argv.appKey
    },
    json: {
      "serviceID": "urn:apemesh-com:serviceID:ApiStatService",
      "actionName": "getDeviceSpec",
      "input": {
        deviceID: deviceID
      }
    }
  };
  request(option, function(err, res, body) {
    if (res.statusCode > 200) return callback('unknown device');
    return callback(body.output.spec.device.friendlyName);
  });
};

function walk(obj, dirName, callback) {
  //console.log(dirName);
  var keys = Object.keys(obj);

  if (obj.deviceList && obj.deviceList.length > 0) {
    async.eachSeries(obj.deviceList, function(item, cb) {
      getItemName(item, function(name) {
        console.log(dirName + ': ' + name);
        return cb();
      });
    }, function(err) {

      async.eachSeries(keys, function(i, callb) {
        if (i === 'deviceList') return callb();
        walk(obj[i], dirName + '/' + i, function() {
          return callb();
        });
      }, function(err) {
        return callback();
      });

    });
  } else {

    async.eachSeries(keys, function(i, callb) {
      if (i === 'deviceList') return callb();
      walk(obj[i], dirName + '/' + i, function() {
        return callb();
      });
    }, function(err) {
      return callback();
    });

  }
};

request(opts, function(err, res, body) {
  var resTree = body.output.resourceTree;
  walk(resTree, 'root', function(){});

});



