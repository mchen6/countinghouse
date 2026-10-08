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
    "./pre-installed-packages/echo-device-client-module"
  ], {silent: true});

  // the sub-tests wait for the server's ready line in this (see
  // test/helpers/wait-for-ready.js); captured from the moment of the fork
  child.log = '';
  child.stdout.on('data', (chunk) => { child.log += chunk; });
  child.stderr.on('data', (chunk) => { child.log += chunk; });

  testFiles.forEach((file) => {
    require(`./job-control/${file}`)(child, false);
  });
});

