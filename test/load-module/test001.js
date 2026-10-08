
const request = require('supertest');
const waitForReady = require('../helpers/wait-for-ready');
const url = 'http://127.0.0.1:9527';


module.exports = function (cp, isSingleThread) {
  describe('Test the server reports ready', function() {
    this.timeout(0);

    it('should log the ready line after all modules loaded', (done) => {
      waitForReady.inText(() => cp.log, done);
    });
  });
};


