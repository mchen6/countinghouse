const express = require('express');
const Session = require('../session');

module.exports = function(mm, cdifInterface) {
  const router = express.Router();

  router.route('/').post((req, res) => {
    const path     = req.body.path;
    const name     = req.body.name;
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
