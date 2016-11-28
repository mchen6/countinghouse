var options       = require('../cli-options');
var Session       = require('../session');

var validateUser = function(req, res, next) {
  if (options.isDebug === true) {
    var session = new Session(req, res);
    req.session = session;
    return next();
  }

  var appkey = req.get('X-Apemesh-Key');

  // find a user from couch, cache it's appKey in memory or redis
  if (appkey === '123456') {
    // here we create a new session obj on each request
    // better if we can reuse it, after a existing session obj (which is indexed by appKey) completes a request
    var session = new Session(req, res);

    if (session == null) {
      res.status(500).json({message: 'cannot allocate session'});
    } else {
      req.session = session;
      next();
    }
  } else {
    res.status(500).json({message: 'user not found'});
  }
}

module.exports = validateUser;
