const express = require('express');
const Session = require('../session');

module.exports = function() {
  const router = express.Router();

  router.route('/').post((req, res) => {
    process.exit(0);
  });
  return router;
}
