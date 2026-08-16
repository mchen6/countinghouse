const request = require('supertest');
const url = 'http://127.0.0.1:9527';


module.exports = function (cp, isSingleThread) {
  describe('Test reload-module API', function() {
    this.timeout(0);
    const req = { path: './pre-installed-packages/echo-device-module' };

    it('should reload successfully', (done) => {
      // /shutdown is now admin-gated (lib/routes/admin-only.js) -- both
      // calls below need this server's --debugKey, same as reload-module
      // already sent.
      if (isSingleThread === false) {
        request(url).post('/shutdown').set('X-CH-Key', 'aabbcc').end(() => {});
        return done();  // reload-module http API is not supported in MT mode now, it is only used by countinghouse docker image
      }
      request(url).post('/reload-module')
      .set('X-CH-Key', 'aabbcc')
      .set('Content-Type', 'application/json')
      .send(req)
      .expect('Content-Type', /[json | text]/)
      .expect(200, (err, res) => {
        if (err) return done(err);
        request(url).post('/shutdown').set('X-CH-Key', 'aabbcc').end(() => {});
        return done();
      });
    });
  });
};


