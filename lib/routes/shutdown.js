var express = require('express');
var Session = require('../session');

module.exports = function() {
  var router = express.Router();

  router.route('/').post(function(req, res) {
    process.exit(0);
  });
  return router;
}
