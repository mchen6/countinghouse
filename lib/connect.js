const CountinghouseError = require('./countinghouse-error').CountinghouseError;

function ConnectManager(cdifDevice) {
  this.device = cdifDevice;
}

//TODO: support multi-user secrets
ConnectManager.prototype.verifyConnect = function(user, pass, callback) {
  callback(null, null, null);
  // if (this.device.spec.device.userAuth === true) {
  //   if (this.device.secret === '') {
  //     return callback(new CountinghouseError('cannot verify password'), null, null);
  //   }
  //   if (this.device.user !== user) {
  //     return callback(new CountinghouseError('username not match'), null, null);
  //   }
  //   this.device.auth.compareSecret(pass, this.device.secret, function(err, res) {
  //     if (!err && res === true) {
  //       return callback(null, this.device.secret, null);
  //     }
  //     if (!err) {
  //       return callback(new CountinghouseError('password not match'), null, null);
  //     }
  //     return callback(new CountinghouseError(err.message), null, null);
  //   }.bind(this));
  // } else {
  //   callback(null, null, null);
  // }
};

ConnectManager.prototype.processConnect = function(user, pass, callback) {
  if (this.device._connect && typeof(this.device._connect) === 'function') {
    this.device._connect(user, pass, (error, redirectObj) => {
      if (error) {
        return callback(CountinghouseError.device('DEVICE_CONNECT_FAIL', error.message), null, null);
      }

      if (redirectObj != null) {
        if (typeof(redirectObj) !== 'object') {
          return callback(CountinghouseError.device('INVALID_REDIRECT_URL'), null, null);
        }
        if (redirectObj.href == null || redirectObj.method == null) {
          return callback(CountinghouseError.device('INVALID_REDIRECT_URL', JSON.stringify(redirectObj)), null, null);
        }
        this.device.connectionState = 'redirecting';
      } else {
        this.device.connectionState = 'connected';
      }
      callback(null, null, redirectObj);
      // if (this.device.spec.device.userAuth === true) {
      //   this.device.auth.getSecret(this.device.deviceID, pass, function(err, secret) {
      //     if (!err) {
      //       this.device.user = user;
      //       this.device.secret = secret;
      //     }
      //     callback(err, secret);
      //   }.bind(this));
      // } else {
      //   callback(null, null, redirectObj);
      // }
    });
  } else {
    this.device.connectionState = 'connected';
    callback(null, null, null);
  }
  //   if (this.device.spec.device.userAuth === true) {
  //     // TODO: may create auth strategy later on
  //     callback(new CountinghouseError('cannot authenticate this device'), null, null);
  //   } else {
  //     this.device.connectionState = 'connected';
  //     callback(null, null, null);
  //   }
  // }
};

ConnectManager.prototype.processDisconnect = function(callback) {
  if (this.device.connectionState === 'connected' || this.device.connectionState === 'redirecting') {
    if (this.device._disconnect && typeof(this.device._disconnect) === 'function') {
      this.device._disconnect((error) => {
        if (error) {
          return callback(CountinghouseError.device('DEVICE_DISCONNECT_FAIL', error.message));
        }
        // if (this.device.spec.device.userAuth === true) {
        //   this.device.user = ''; this.device.secret = '';
        // }
        this.device.connectionState = 'disconnected';
        callback(null);
      });
    } else {
      // if (this.device.spec.device.userAuth === true) {
      //   this.device.user = ''; this.device.secret = '';
      // }
      this.device.connectionState = 'disconnected';
      callback(null);
    }
  } else {
    callback(CountinghouseError.device('DEVICE_NOT_CONNECTED'));
  }
};

module.exports = ConnectManager;
