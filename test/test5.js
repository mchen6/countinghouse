var fs = require('fs');
var cp = require('child_process');

var testFiles = fs.readdirSync(__dirname + '/job-control');

describe("Start job control tests in multi thread mode", function () {
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
    "--apiCache",
    "--apiMonitor",
    "--redisUrl",
    "redis://127.0.0.1:6379",
    "--loadModule",
    "./pre-installed-packages/echo-device-module",
    "--loadModule",
    "./pre-installed-packages/lingyi-fire-control-data-module",
    "--loadModule",
    "./pre-installed-packages/echo-device-client-module",
    "--withPM2"
  ], {silent: true});

  testFiles.forEach(function (file) {
    require('./job-control/' + file)(child, false);
  });
});

