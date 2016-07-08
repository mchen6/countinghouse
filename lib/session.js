var CdifError   = require('./error').CdifError;
var DeviceError = require('./error').DeviceError;
var uuid        = require('uuid');

function Session(req, res) {
  this.req  = req;
  this.res  = res;
  this.uuid = uuid.v4();

  this.redirect = this.redirect.bind(this);
  this.callback = this.callback.bind(this);
};

Session.prototype.redirect = function(url) {
  this.res.redirect(url);
};

//TODO: consider wrap this with https://www.npmjs.com/package/once
Session.prototype.callback = function(err, data) {
  // console.log(new Error().stack);
  if (this.res) {
    this.res.setHeader('Content-Type', 'application/json');
    if (err) {
      this.res.status(500).json({topic: err.topic, message: err.message});
    } else {
      this.res.status(200).json(data);
    }
  }
};

module.exports = Session;
