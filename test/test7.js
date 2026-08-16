const fs = require('fs');
const cp = require('child_process');
const request = require('supertest');
const url = 'http://127.0.0.1:9527';

const testFiles = fs.readdirSync(`${__dirname}/benchmark`);

describe("Start benchmarking in multi-thread mode", function () {
  let child = null;
  this.timeout(0);
  console.log('starting countinghouse...');
  child = cp.fork("./framework.js", [
    "--bindAddr",
    "127.0.0.1",
    "--workerThread",
    "--debug",
    "--debugKey",
    "aabbcc",
    "--loadModule",
    "./pre-installed-packages/echo-device-module",
    "--loadModule",
    "./pre-installed-packages/echo-device-client-module",
    "--withPM2"
  ], {silent: true});

  testFiles.forEach((file) => {
    require(`./benchmark/${file}`)(child, false);
  });
});

