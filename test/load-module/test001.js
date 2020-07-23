
var request = require('supertest');
var url = 'http://127.0.0.1:9527';


module.exports = function (cp, isSingleThread) {
  describe('Test all modules discovered event', function() {
    this.timeout(0);

    it('should receive ready event after all modules loaded', function(done) {
      cp.on('message', message => {
        if (message !== 'ready') return done(new Error('didnt receive ready message'));
        return done();
      });
    });
  });
};


