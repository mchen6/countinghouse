var fs = require('fs');
var cp = require('child_process');
var request = require('supertest');
var url = 'http://127.0.0.1:9527';

var testFiles = fs.readdirSync(__dirname + '/benchmark');

describe("Start benchmarking in multi-thread mode", function () {
  var child = null;
  this.timeout(0);
  console.log('starting cdif...');
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

  testFiles.forEach(function (file) {
    require('./benchmark/' + file)(child, false);
  });
});

