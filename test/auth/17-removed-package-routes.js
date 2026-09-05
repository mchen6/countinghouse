const fs      = require('fs');
const exec    = require('child_process').exec;
const request = require('supertest');

// The CEAMS-era package routes. countinghouse was the verification half of
// CEAMS, an external all-in-one API package platform (now retired) that
// published verified packages to CouchDB and listed them on its own website.
// With CEAMS gone and npm as the distribution channel, two of those four
// routes have no remaining consumer:
//
//   POST /verify-module -- parsed an uploaded .tgz (package.json, api.json,
//     schema.json). Superseded by countinghouse_validate_module, which runs
//     the validator in a CHILD PROCESS, cross-checks the handler map too, and
//     reports every problem rather than the first. npm untars, so a tarball
//     parser has no job.
//   GET /devices/:deviceID/download-package -- packaged a loaded module for
//     download, which was CEAMS's download step. npm serves packages now.
//
// The other two survive and are covered further down this file.
const PORT             = 9549;
const url              = `http://127.0.0.1:${PORT}`;
const AUTH_CONFIG_PATH = `/tmp/countinghouse-test-auth-17-${process.pid}.json`;

const ADMIN = `admin-key-17-${process.pid}`;

describe('auth 17: the CEAMS-era package routes with no consumer are gone', function() {
  this.timeout(0);

  before(function(done) {
    this.timeout(0);

    const config = {};
    config[ADMIN] = {userName: 'admin17', devices: ['*'], admin: true};
    fs.writeFileSync(AUTH_CONFIG_PATH, JSON.stringify(config));

    console.log('starting countinghouse for removed-package-route test...');
    exec(`"./bin/countinghouse" --workerThread --bindAddr 127.0.0.1 --port ${PORT
         } --authProvider file --authConfigPath ${AUTH_CONFIG_PATH
         } --loadModule ./pre-installed-packages/echo-device-module`,
         (err, stdout, stderr) => { console.log(err); });
    setTimeout(() => { done(); }, 13000);
  });

  after((done) => {
    try { fs.unlinkSync(AUTH_CONFIG_PATH); } catch (e) {}
    exec(`pkill -f "framework.js.*${AUTH_CONFIG_PATH}"`, () => { done(); });
  });

  // Without this, every 404 below could pass because the server never booted.
  it('the server is up (guard: proves the 404s below mean "no such route")', (done) => {
    request(url).get('/balance').set('X-CH-Key', ADMIN).expect(200, done);
  });

  it('POST /verify-module is 404', (done) => {
    request(url).post('/verify-module')
                .set('X-CH-Key', ADMIN)
                .set('Content-Type', 'application/json')
                .send({name: '/tmp/whatever.tgz', path: '/tmp'})
                .expect(404, done);
  });

  it('GET /devices/:deviceID/download-package is 404', (done) => {
    request(url).get('/devices/some-device-id/download-package')
                .set('X-CH-Key', ADMIN)
                .expect(404, done);
  });

  // The two package routes that survive. Both are covered here because Task 4
  // adds their cross-cutting-matrix rows, and a row asserting behavior that
  // nothing tests is worse than a blank cell.

  it('POST /get-module-device-list returns a loaded module device list', (done) => {
    request(url).post('/get-module-device-list')
                .set('X-CH-Key', ADMIN)
                .set('Content-Type', 'application/json')
                .send({name: 'echo-device-module'})
                .expect(200, (err, res) => {
      if (err) return done(err);
      if (!Array.isArray(res.body) && typeof(res.body) !== 'object') {
        return done(new Error(`expected a device list object/array, got: ${JSON.stringify(res.body)}`));
      }
      return done();
    });
  });

  it('GET /devices/:deviceID/package-info returns the module name and version', (done) => {
    request(url).get('/device-list').set('X-CH-Key', ADMIN).expect(200, (listErr, listRes) => {
      if (listErr) return done(listErr);
      const first = Array.isArray(listRes.body) ? listRes.body[0] : null;
      const deviceID = (first && first.device && first.device.deviceID) ? first.device.deviceID : null;
      if (deviceID == null) {
        return done(new Error(`could not find a deviceID in /device-list: ${JSON.stringify(listRes.body).slice(0, 400)}`));
      }
      return request(url).get(`/devices/${deviceID}/package-info`)
                         .set('X-CH-Key', ADMIN)
                         .expect(200, (err, res) => {
        if (err) return done(err);
        if (res.body == null || typeof(res.body.name) !== 'string' || typeof(res.body.version) !== 'string') {
          return done(new Error(`expected {name, version} strings, got: ${JSON.stringify(res.body)}`));
        }
        return done();
      });
    });
  });
});
