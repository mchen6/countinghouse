var express   = require('express');
var os        = require('os');
var rimraf    = require('rimraf');
var exec      = require('child_process').exec;
var path      = require('path');
var LOG       = require('../logger');

module.exports = function(mm, cdifInterface) {
  var router = express.Router({mergeParams: true});

  router.route('/').get(function(req, res) {
    var session   = req.session;
    var deviceID  = req.params.deviceID;

    cdifInterface.getDevicePackageModulePath(deviceID, function(err, info) {
      if (err) return session.callbackWithoutTimer(err);
      if (info.spec == null || typeof(info.spec) !== 'object') return session.callbackWithoutTimer(new Error('found illegal device spec'));
      if (info.modulePath == null) return session.callbackWithoutTimer(new Error('found illegal device module path'));


      var resourceIndex = info.spec.device.resourceIndex;

      if (resourceIndex == null || typeof(resourceIndex) !== 'string') return session.callbackWithoutTimer(new Error('module resource index unknown'));

      var arr = resourceIndex.split('/');
      if (arr.length <= 1) return session.callbackWithoutTimer(new Error('invalid module resource index, should have leading slash'));
      if (arr[1] !== '公共模板') return session.callbackWithoutTimer(new Error('module type invalid'));

      var command = 'cd ' + os.tmpdir() + ' && npm pack ' + info.modulePath;

      exec(command, function (err, stdout, stderr) {
        if (err) return session.callbackWithoutTimer(err);

        var fileName = stdout.substring(0, stdout.lastIndexOf('\n'));
        var filePath = path.join(os.tmpdir(), fileName);

        res.download(filePath, function(err) {
          if (err) LOG.E(err);
          rimraf(filePath, function(e) {});
        });
      });
    });
  });
  return router;
}

