const express   = require('express');
const os        = require('os');
const rimraf    = require('rimraf');
const exec      = require('child_process').exec;
const path      = require('path');
const LOG       = require('../logger');

module.exports = function(mm, cdifInterface) {
  const router = express.Router({mergeParams: true});

  router.route('/').get((req, res) => {
    const session   = req.session;
    const deviceID  = req.params.deviceID;

    cdifInterface.getDevicePackageModulePath(deviceID, (err, info) => {
      if (err) return session.callbackWithoutTimer(err);
      if (info.spec == null || typeof(info.spec) !== 'object') return session.callbackWithoutTimer(new Error('found illegal device spec'));
      if (info.modulePath == null) return session.callbackWithoutTimer(new Error('found illegal device module path'));


      const resourceIndex = info.spec.device.resourceIndex;

      if (resourceIndex == null || typeof(resourceIndex) !== 'string') return session.callbackWithoutTimer(new Error('module resource index unknown'));

      const arr = resourceIndex.split('/');
      if (arr.length <= 1) return session.callbackWithoutTimer(new Error('invalid module resource index, should have leading slash'));
      // NOTE: '公共模板' here is a *data value* -- a module-type marker that
      // appears in existing package names -- not a user-facing message, so it
      // is deliberately left as-is. Changing it would change which packages
      // this route accepts. (The user-facing message beside it is English.)
      if (arr[1] !== '公共模板') return session.callbackWithoutTimer(new Error('module type invalid'));

      const command = `cd ${os.tmpdir()} && npm pack ${info.modulePath}`;

      exec(command, (err, stdout, stderr) => {
        if (err) return session.callbackWithoutTimer(err);

        const fileName = stdout.substring(0, stdout.lastIndexOf('\n'));
        const filePath = path.join(os.tmpdir(), fileName);

        res.download(filePath, (err) => {
          if (err) LOG.E(err);
          rimraf(filePath, (e) => {});
        });
      });
    });
  });
  return router;
}

