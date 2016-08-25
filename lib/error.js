var logger = require('./logger');

function CdifError(message) {
  this.topic   = 'cdif error';
  this.message = message;
  logger.error('CDIF error: ' + message);
}
CdifError.prototype = new Error;

function DeviceError(message) {
  this.topic   = 'device error';
  this.message = message;
  logger.error('Device error: ' + message);
}
DeviceError.prototype = new Error;

module.exports = {
  CdifError: CdifError,
  DeviceError: DeviceError
};
