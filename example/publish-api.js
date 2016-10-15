'use strict'

var request  = require('request');
var UUID     = require('uuid-1345');
var nano     = require('nano')('http://localhost:5984');
var deviceDB = nano.db.use('devices');

var verifyOptions = {
  url: 'http://localhost:3049/verify-module',
  headers: {
    'Accept': 'application/json',
    'Content-Type': 'application/json'
  },
  method: 'POST',
  json: {
      name: '/home/mchen6/tmp/cdif-weibo-0.0.21.tgz'
  }
};


request(verifyOptions, function(err, response, body) {
  if (err) {
    return console.log(err);
  }

  console.log(body.packageInfo);
  var packageInfo = body.packageInfo;
  var deviceList  = body.deviceList;

  var publishOptions = {
    url: 'http://localhost:3049/publish-module',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    },
    method: 'POST',
    json: {
        username: 'out4b',
        password: 'xsVLX842',
        email: 'seeds.c@gmail.com',
        registry: 'http://localhost:5984/registry/_design/app/_rewrite/',
        name: '/home/mchen6/tmp/cdif-weibo-0.0.21.tgz',
        info: packageInfo
    }
  };

  request(publishOptions, function(e, response, body) {
    if (response.statusCode > 200) {
      return console.log('publish failed: ' + body.message);
    }

    // publish done, add device info into devices db
    // NOTICE: the uuid generation rule MUST be consistent in CDIF and web site
    for (var id in deviceList) {
      var device = deviceList[id];
      var deviceID = device.spec.device.deviceID;
      console.log(deviceID);

      var _id = device.spec.device.friendlyName;   // we use friendlyName as device document _id
      deviceDB.get(_id, function(err, b) {
        var deviceDocument = {};
        deviceDocument.deviceID    = deviceID;
        deviceDocument.packageInfo = packageInfo;
        deviceDocument.spec        = device.spec;
        deviceDocument._id         = _id;
        deviceDocument.author      = 'out4b';    // TODO: change this to the real user name whom logged in

        if (b && b._rev != null) {
          deviceDocument._rev = b._rev;
        }

        deviceDB.insert(deviceDocument, function(e, body, header) {
          console.log('nano returun body: ' + JSON.stringify(body));
        });
      });
    }
  });
});

