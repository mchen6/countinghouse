var fs = require('fs');
var cp = require('child_process');
var request = require('supertest');
var url = 'http://127.0.0.1:9527';

var testFiles = fs.readdirSync(__dirname + '/load-module');

describe("Start load module test in multi thread mode", function () {
  var child = null;
  this.timeout(0);
  console.log('starting cdif...');
  child = cp.fork("./framework.js", [
    "--bindAddr",
    "127.0.0.1",
    "--debug",
    "--debugKey",
    "aabbcc",
    "--workerThread",
    "--apiCache",
    "--apiMonitor",
    "--loadModule",
    "./pre-installed-packages/echo-device-module",
    "--loadModule",
    "./pre-installed-packages/lingyi-fire-control-data-module",
    "--loadModule",
    "./pre-installed-packages/echo-device-client-module",
    "--withPM2"
  ]);

  testFiles.forEach(function (file) {
    require('./load-module/' + file)(child);
  });
});

