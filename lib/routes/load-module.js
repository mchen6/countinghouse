const express = require('express');
const fs      = require('fs');
const pathMod = require('path');
const Session = require('../session');

// A REST load may omit name; the package.json name is the only name 8.0.0
// accepts anyway. If package.json cannot be read, the missing name goes
// through and the load reports the real problem.
function packageName(modulePath) {
  try {
    const name = JSON.parse(fs.readFileSync(pathMod.join(String(modulePath), 'package.json'), 'utf8')).name;
    return typeof(name) === 'string' ? name : undefined;
  } catch (e) {
    return undefined;
  }
}

module.exports = function(mm, cdifInterface) {
  const router = express.Router();

  router.route('/').post((req, res) => {
    const path     = req.body.path;
    const name     = (typeof(req.body.name) === 'string') ? req.body.name : packageName(path);
    const version  = req.body.version;
    const session = new Session(req, res, 'debug', 'debug', 0, null, null, null);

    // loadModuleFromPath calls back with the live module instance. Passing
    // that straight to the response serialized the framework's internals to
    // the caller -- msgQueue, the worker_threads handle, workerId,
    // rateLimiters, deviceList and so on. None of it is meaningful to a
    // caller and none of it should be on the wire, so the response is
    // reduced to the minimum that answers "did it load, and what is it".
    mm.loadModuleFromPath(path, name, version, (err, moduleInstance) => {
      if (err != null) return session.callbackWithoutTimer(err);

      return session.callbackWithoutTimer(null, {
        loaded:  true,
        name:    name,
        version: version
      });
    });
  });
  return router;
}

// data.loadModule.path, data.loadModule.name, data.loadModule.version
