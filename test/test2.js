const fs = require('fs');
const exec = require('child_process').exec;
const request = require('supertest');
const url = 'http://127.0.0.1:9527';

const testFiles = fs.readdirSync(`${__dirname}/unit`);

describe("Test started in COUNTINGHOUSE single-thread mode", () => {
  before(function (done) {
    this.timeout(0);
    console.log('starting countinghouse...');
    exec('"./bin/countinghouse" --debug --bindAddr 127.0.0.1 --debugKey aabbcc --apiMonitor --loadModule ./pre-installed-packages/echo-device-module --loadModule ./pre-installed-packages/echo-device-client-module', (err, stdout, stderr) =>{console.log(err)});
    // Same startup race as test1.js: 5000ms is not enough for two modules
    // to finish discovery, and the shortfall shows up as spurious
    // DEVICE_NOT_FOUND rather than as a startup failure.
    setTimeout(() => {
      done();
    }, 13000);
  });

  testFiles.forEach((file) => {
    if (file !== 'input.bson' && file !== 'test018.js') require(`./unit/${file}`);
  });

  after((done) => {
    console.log('test ended');
    request(url).post('/shutdown')
    .set('X-CH-Key', 'aabbcc') // /shutdown is now admin-gated (lib/routes/admin-only.js) -- this server's --debugKey
    .end(() => {
      done();
    });
  });
});

