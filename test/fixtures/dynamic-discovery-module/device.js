const fs = require('fs');

// One CHDevice per backing "resource". friendlyName has to differ per
// instance: deviceID is UUID.v5 of it (see lib/call-address.js's
// deviceIDForName), so two instances sharing a name would collide into one
// device.
function Device(instanceName) {
  const spec = JSON.parse(fs.readFileSync(`${__dirname}/api.json`).toString());
  spec.device.friendlyName = instanceName;

  CHDevice.call(this, spec);
  this.instanceName = instanceName;

  this.setAction('urn:countinghouse-test:serviceID:dynService', 'hello',
    (args, callback) => callback(null, {output: {name: this.instanceName}}));

  // What the dynamic path exists for: the module notices its backing resource
  // is gone and withdraws just that device. Deferred a tick so the reply to
  // this call goes out before the device leaves deviceMap.
  this.setAction('urn:countinghouse-test:serviceID:dynService', 'retire',
    (args, callback) => {
      setTimeout(() => { this.emit('retire-me', this); }, 50);
      return callback(null, {output: {retiring: this.instanceName}});
    });
}

CHUtil.inherits(Device, CHDevice);

Device.prototype._getDeviceRootSchema = function() {
  return JSON.parse(fs.readFileSync(`${__dirname}/schema.json`).toString());
};

module.exports = Device;
