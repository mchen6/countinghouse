const fs = require('fs');
const cp = require('child_process');

const testFiles = fs.readdirSync(`${__dirname}/job-control`);

describe("Start job control tests in multi thread mode", function () {
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
    "--apiMonitor",
    "--redisUrl",
    "redis://127.0.0.1:6379",
    "--loadModule",
    "./pre-installed-packages/echo-device-module",
    "--loadModule",
    "./pre-installed-packages/echo-device-client-module",
    "--withPM2"
  ], {silent: true});

  testFiles.forEach((file) => {
    require(`./job-control/${file}`)(child, false);
  });
});

